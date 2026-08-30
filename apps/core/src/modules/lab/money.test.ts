import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkCashier, openSessionFor } from "../../../test/helpers/billing";
import {
  grantLabResultPermissions, runLabOrder, seedLabDeskBase, serviceIdForLabCode, uhidOf,
} from "../../../test/helpers/lab";
import { withTx } from "../../kernel/db/client";
import { creditNotes, events, labItems, orderItems, workflowInstances } from "../../kernel/db/schema";
import { collect } from "./collection";
import { deskOrder } from "./desk";
import { cancelLabItem, chargeReasonFor, deskOrderAtCounter, refundOnCancel } from "./money";
import { printLabels } from "./specimens";
import { receive } from "./accession";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 17b T7 — **THE MONEY RULE (DD7)**. Assertion Book row **A5**, plus 17a §9.2 **F27**'s repair.
 *
 * `money.ts` is the close reviewer's first file (§9.6) and A5 is the reason: the mutant that
 * ignores `cancelled_from` refunds 1/1/1 where the rule says 1/0/1, which hands back the price of
 * every test the laboratory actually ran and then had withdrawn — silently, on the ordinary
 * clinical path, with green suites either way.
 */
const AT = new Date("2026-08-30T06:00:00Z");

describe("lab cancellation money and the counter's cash lane (17b T7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
  });
  afterEach(() => { fx.unregister(); });

  const notesFor = async () => db.select().from(creditNotes);
  const eventsNamed = async (name: string) =>
    db.select().from(events).where(eq(events.name, name));

  /** An order left at `placed` — labelled but never drawn, so the envelope has not started. */
  async function placedOnly(code: string) {
    const placed = await withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
      patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id,
      items: [{ serviceId: serviceIdForLabCode(code) }],
      credit: { reason: "counter order" }, placedAt: AT,
    }, AT));
    return placed;
  }

  /** An order whose tube reached the bench — `in_progress` — with NO number keyed against it. */
  async function receivedOnly(code: string) {
    const placed = await placedOnly(code);
    const { specimens } = await printLabels(db, fx.bench.actor, {
      orderGroupId: placed.orderGroupId, scannedUhid: await uhidOf(db, fx.patientId),
    }, AT);
    for (const s of specimens) {
      await withTx(db, (tx) => collect(tx, fx.bench.actor, { specimenId: s.specimenId, wristbandScanned: true }, AT));
      await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: s.specimenNo }, AT));
    }
    return placed;
  }

  /* ═══════════════════════════ A5 — DD7's THREE LEGS ═══════════════════════════ */

  it("A5 leg 1: cancelled from `placed` ⇒ ONE credit note for exactly that line's paise", async () => {
    const placed = await placedOnly("TSH");
    const out = await withTx(db, (tx) => cancelLabItem(tx, fx.pathologist.actor, fx.decls, {
      orderItemId: placed.itemIds[0]!, reason: "patient left the counter",
    }, AT));

    expect([out.cancelledFrom, out.refund.workDone]).toEqual(["placed", false]);
    const notes = await notesFor();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.invoiceId).toBe(placed.invoice.invoiceId);
    /** EXACTLY that line's money — the whole invoice here, because the order carried one test. */
    expect(out.refund.creditedPaise).toBe(placed.invoice.netPayablePaise);
    expect(notes[0]!.netPaise).toBe(placed.invoice.netPayablePaise);
  });

  it("A5 leg 2: cancelled from `in_progress` WITH a result ⇒ NO credit note — the charge stands", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT, verify: false });
    const before = (await notesFor()).length;

    const out = await withTx(db, (tx) => cancelLabItem(tx, fx.pathologist.actor, fx.decls, {
      orderItemId: run.itemIds[0]!, reason: "clinician withdrew the request",
    }, AT));

    expect([out.cancelledFrom, out.refund.workDone, out.refund.creditNoteId])
      .toEqual(["in_progress", true, null]);
    expect((await notesFor()).length).toBe(before);
    /**
     * ═══ AND THE LAB INSTANCE IS LEFT AT `resulted` — §9.2 F37, ASSERTED RATHER THAN HIDDEN ═══
     *
     * `LAB_ITEM_DEFINITION_JSON` declares no `resulted → cancelled` edge and `workflow-def.ts` is
     * frozen for this phase (§8). The envelope IS cancelled and the money rule IS applied; the lab
     * machine cannot follow, and `cancelLabItem` returns the state it was left in rather than
     * pretending. Nothing reads it in isolation — every worklist keys off `order_items.status`.
     */
    expect(out.labInstanceState).toBe("resulted");
    /**
     * THE MUTANT'S WORLD: 1/1/1 instead of 1/0/1. The laboratory ran the sample, consumed the
     * reagent and keyed the number, and the legacy rule an Indian laboratory works to is that the
     * charge stands from that moment (02 O-4). A refund here is money the hospital never gets back
     * and nobody ever sees leave.
     */
  });

  it("A5 leg 3: cancelled from `in_progress` WITHOUT a result ⇒ credit note", async () => {
    const placed = await receivedOnly("TSH");
    const out = await withTx(db, (tx) => cancelLabItem(tx, fx.pathologist.actor, fx.decls, {
      orderItemId: placed.itemIds[0]!, reason: "sample lost in the analyser",
    }, AT));

    expect([out.cancelledFrom, out.refund.workDone]).toEqual(["in_progress", false]);
    expect(out.refund.creditNoteId).not.toBeNull();
    expect((await notesFor())).toHaveLength(1);
  });

  it("the cancel and its refund are ONE atom, and the lab's own machine follows the envelope", async () => {
    const placed = await receivedOnly("TSH");
    await withTx(db, (tx) => cancelLabItem(tx, fx.pathologist.actor, fx.decls, {
      orderItemId: placed.itemIds[0]!, reason: "sample lost",
    }, AT));

    const [item] = await db.select({ status: orderItems.status, cancelledFrom: orderItems.cancelledFrom })
      .from(orderItems).where(eq(orderItems.id, placed.itemIds[0]!));
    expect([item!.status, item!.cancelledFrom]).toEqual(["cancelled", "in_progress"]);
    const [instance] = await db.select({ state: workflowInstances.currentState })
      .from(workflowInstances).where(eq(workflowInstances.subjectId, placed.itemIds[0]!));
    expect(instance!.state).toBe("cancelled");
  });

  it("refundOnCancel refuses item_not_cancellable on a live item, and gates on orders.cancel", async () => {
    const placed = await receivedOnly("TSH");
    await expect(withTx(db, (tx) => refundOnCancel(tx, fx.pathologist.actor, placed.itemIds[0]!, AT)))
      .rejects.toMatchObject({ code: "item_not_cancellable" });

    const cashier = await mkCashier(db, "cash.only");
    await expect(withTx(db, (tx) => cancelLabItem(tx, cashier.actor, fx.decls, {
      orderItemId: placed.itemIds[0]!, reason: "no",
    }, AT))).rejects.toMatchObject({ code: "permission_denied" });
    expect(await notesFor()).toHaveLength(0);
  });

  /* ═══════════════════ `chargeReasonFor` — 26 reads this column ═══════════════════ */

  it("chargeReasonFor maps the envelope's origin, and a walk-in is not a counter order", () => {
    expect([
      chargeReasonFor("direct"), chargeReasonFor("direct", true),
      chargeReasonFor("addon"), chargeReasonFor("reflex"), chargeReasonFor("duplicate_confirmed"),
    ]).toEqual(["lab_desk", "lab_walkin", "lab_addon", "lab_reflex", "lab_desk"]);
  });

  it("deskOrderAtCounter stores lab_walkin for an external-prescription order", async () => {
    const placed = await deskOrderAtCounter(db, fx.desk.actor, fx.decls, {
      patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id,
      items: [{ serviceId: serviceIdForLabCode("TSH") }],
      credit: { reason: "walk-in" },
      authority: "external_prescription", referrerName: "Dr Sharma", attributionConfirmed: true,
      placedAt: AT,
    }, AT);
    const [item] = await db.select({ chargeReason: labItems.chargeReason })
      .from(labItems).where(eq(labItems.orderItemId, placed.itemIds[0]!));
    expect(item!.chargeReason).toBe("lab_walkin");
  });

  /* ══════════ F27 — THE §269ST REFUSAL REACHES THE AUDIT LOG THROUGH THE DESK ══════════ */

  it("F27: a cash refusal at the lab counter leaves a cash_threshold.blocked row", async () => {
    /**
     * ═══ WHAT THIS ROW IS ABOUT ═══
     *
     * `issueInvoice` appends the §269ST refusal on `withTx(db, …)` inside its own `catch`. Through
     * `deskOrder` that `db` is a `Tx`, so the append lands on a SAVEPOINT of a transaction that is
     * about to roll back and the refusal leaves NO RECORD ANYWHERE. `deskOrderAtCounter` holds the
     * real `Db` and writes the audit lane on it — `printLabels`' shape (17a F20).
     */
    const cashier = await mkCashier(db, "lab.cash");
    await openSessionFor(db, cashier, 0);
    /** The desk itself needs a drawer to take money — a receipt is drawer-bound (billing D9). */
    await openSessionFor(db, { id: fx.desk.id }, 0);

    /** The event's own name is `cash_threshold.blocked`; `billing` is its MODULE, carried apart. */
    const before = (await eventsNamed("cash_threshold.blocked")).length;
    /** ₹2,10,000 in cash, against §269ST's ₹2,00,000 ceiling — refused, and it must be recorded. */
    await expect(deskOrderAtCounter(db, fx.desk.actor, fx.decls, {
      patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id,
      items: [{ serviceId: serviceIdForLabCode("TSH") }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 21_000_000 }] },
      placedAt: AT,
    }, AT)).rejects.toMatchObject({ code: "cash_threshold_blocked" });

    const after = await eventsNamed("cash_threshold.blocked");
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)!.payload).toMatchObject({ patientId: fx.patientId });

    /** And the order itself rolled back — the audit lane is the ONLY thing that survived. */
    expect(await db.select().from(orderItems)).toHaveLength(0);
  });
});
