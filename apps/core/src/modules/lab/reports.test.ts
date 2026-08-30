import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkCashier, openSessionFor } from "../../../test/helpers/billing";
import {
  grantLabResultPermissions, runLabOrder, seedLabDeskBase, settleInvoice,
} from "../../../test/helpers/lab";
import { mkUser } from "../../../test/helpers/opd";
import { approveRequest } from "../../kernel/approvals/decisions";
import { requestApproval } from "../../kernel/approvals/requests";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  events, labAnalytes, labReportDeliveries, labReports, labResults, notifications, patients,
  phiAccessLog, workflowInstances,
} from "../../kernel/db/schema";
import { patientBalance } from "../billing";
import { registerLabApprovalTypes, RELEASE_UNPAID_APPROVAL_TYPE } from "./approval-types";
import {
  amendReport, getReport, listResultsForEncounter, printReport, publishReport, releaseUnpaid,
  reportVersions,
} from "./reports";
import { amendResult } from "./results";
import { verifyResult } from "./verify";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 17b T7 — **THE DOCUMENT**. Assertion Book rows **A3, A4, A6, A7, A8, A9**.
 * (A1, A1b and A2 are the interlock's and live in `interlock.test.ts`; A5 is `money.test.ts`.)
 */
const AT = new Date("2026-08-30T06:00:00Z");

describe("lab reports — publish, interlock, print, amend (17b T7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let cashier: { id: string; actor: Actor };
  let billingManager: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    cashier = await mkCashier(db, "lab.cashier");
    await openSessionFor(db, cashier, 0);
    billingManager = await mkUser(db, "mr.rao", ["billing_manager"]);
    await grantPermissionToRole(db, fx.registry, "billing_manager", "lab.reports.release_unpaid");
    await grantPermissionToRole(db, fx.registry, "billing_manager", "lab.reports.print");
    await grantPermissionToRole(db, fx.registry, "billing_manager", "lab.results.read");
  });
  afterEach(() => { fx.unregister(); });

  const eventsNamed = async (name: string) =>
    db.select().from(events).where(eq(events.name, name));

  /* ═════════════════ A3 — THE DOCTOR'S READ IS NEVER HELD FOR MONEY ═════════════════ */

  it("A3: an UNPAID self-pay order's verified results reach the doctor; the PRINT is refused", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);

    /**
     * ═══ THE ONE THING THIS PHASE MUST NOT GET WRONG (02 O-1) ═══
     *
     * The interlock holds a DOCUMENT, never a fact. A version of this reader that consulted
     * `deliveryAllowed` would hide a verified result from the clinician who ordered it, which is
     * the safety defect DD6 exists to avoid rather than to cause.
     */
    const forDoctor = await listResultsForEncounter(db, fx.pathologist.actor, fx.encounterNo, AT);
    expect(forDoctor.length).toBeGreaterThan(0);
    expect(forDoctor[0]!.analyteCode).toBe("TSH");

    await expect(printReport(db, fx.desk.actor, {
      reportId: report.reportId, channel: "print", collectorIdentity: "the patient, UHID card seen",
    }, AT)).rejects.toMatchObject({ code: "report_print_blocked" });

    /** THE REFUSAL SURVIVED ITS OWN ROLLBACK — `printReport` is `Db`-first for this (F20/F27). */
    const blocked = await eventsNamed("lab.report_print_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.payload).toMatchObject({ reportId: report.reportId, reason: "unpaid_invoices" });
    expect(await db.select().from(labReportDeliveries)).toHaveLength(0);
  });

  it("the same print succeeds once the bill is settled, and the register names collector and printer", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    await settleInvoice(db, cashier, fx.patientId, run.invoiceId, run.netPayablePaise, AT);

    const printed = await printReport(db, fx.desk.actor, {
      reportId: report.reportId, channel: "print", collectorIdentity: "Sunita Kumar (daughter), Aadhaar seen",
    }, AT);
    expect(printed.printCount).toBe(1);

    const [delivery] = await db.select().from(labReportDeliveries);
    expect([delivery!.channel, delivery!.deliveredBy, delivery!.collectorIdentity, delivery!.approvalId])
      .toEqual(["print", fx.desk.id, "Sunita Kumar (daughter), Aadhaar seen", null]);
  });

  /* ═══════════ A9 — A PHYSICAL HAND-OVER NAMES ITS COLLECTOR (02 J2 / E42) ═══════════ */

  it("A9: print without a collector identity is refused before anything is written", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    await settleInvoice(db, cashier, fx.patientId, run.invoiceId, run.netPayablePaise, AT);

    await expect(printReport(db, fx.desk.actor, { reportId: report.reportId, channel: "print" }, AT))
      .rejects.toMatchObject({ code: "collector_identity_required" });
    await expect(printReport(db, fx.desk.actor, {
      reportId: report.reportId, channel: "in_person", collectorIdentity: "   ",
    }, AT)).rejects.toMatchObject({ code: "collector_identity_required" });

    expect(await db.select().from(labReportDeliveries)).toHaveLength(0);
    const [row] = await db.select().from(labReports).where(eq(labReports.id, report.reportId));
    expect(row!.printCount).toBe(0);
  });

  /* ═══════ A4 — THE RELEASE PRINTS AND DOES NOT MOVE ONE PAISA (DD6 / 02 O-1) ═══════ */

  it("A4: a granted release prints, records the approval, and leaves the dues IDENTICAL", async () => {
    await registerLabApprovalTypes(db, fx.pathologist.actor);
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);

    const before = await patientBalance(db, fx.desk.actor, fx.patientId);
    expect(before.outstandingPaise).toBeGreaterThan(0);

    const { approvalId } = await withTx(db, (tx) => requestApproval(tx, fx.desk.actor, {
      typeKey: RELEASE_UNPAID_APPROVAL_TYPE,
      subject: { type: "lab_report", id: run.orderId },
      patientId: fx.patientId,
      requestNote: "patient travelling tonight, balance to be cleared on return",
    }));
    await approveRequest(db, billingManager.actor, { approvalId, note: "carry the receivable" });

    const printed = await releaseUnpaid(db, billingManager.actor, {
      reportId: report.reportId, approvalId, collectorIdentity: "the patient, UHID card seen",
    }, AT);
    expect(printed.verdict.reason).toBe("released_by_approval");

    const [delivery] = await db.select().from(labReportDeliveries);
    expect(delivery!.approvalId).toBe(approvalId);

    /**
     * ═══ THE MONEY DID NOT MOVE (T7 A4's whole claim) ═══
     *
     * No credit note, no allocation, no write to `invoices`. The mutant writes off the balance and
     * turns the interlock into a discount mechanism, which is 02 O-1's opposite.
     */
    const after = await patientBalance(db, fx.desk.actor, fx.patientId);
    expect(after.outstandingPaise).toBe(before.outstandingPaise);
    expect(await db.select().from(labReports).where(eq(labReports.id, report.reportId)))
      .toHaveLength(1);

    const released = await eventsNamed("lab.report_released_unpaid");
    expect(released).toHaveLength(1);
    expect(released[0]!.payload).toMatchObject({ approvalId, outstandingPaise: before.outstandingPaise });
  });

  it("a PENDING approval, a wrong-type approval and another order's approval all release nothing", async () => {
    await registerLabApprovalTypes(db, fx.pathologist.actor);
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const other = await runLabOrder(db, fx, ["GLUF"], { at: AT });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);

    const pending = await withTx(db, (tx) => requestApproval(tx, fx.desk.actor, {
      typeKey: RELEASE_UNPAID_APPROVAL_TYPE,
      subject: { type: "lab_report", id: run.orderId }, patientId: fx.patientId,
    }));
    await expect(releaseUnpaid(db, billingManager.actor, {
      reportId: report.reportId, approvalId: pending.approvalId, collectorIdentity: "the patient",
    }, AT)).rejects.toMatchObject({ code: "release_approval_invalid" });

    /** A release granted for ANOTHER order releases nothing here — one grant, one document. */
    const elsewhere = await withTx(db, (tx) => requestApproval(tx, fx.desk.actor, {
      typeKey: RELEASE_UNPAID_APPROVAL_TYPE,
      subject: { type: "lab_report", id: other.orderId }, patientId: fx.patientId,
    }));
    await approveRequest(db, billingManager.actor, { approvalId: elsewhere.approvalId, note: "ok" });
    await expect(releaseUnpaid(db, billingManager.actor, {
      reportId: report.reportId, approvalId: elsewhere.approvalId, collectorIdentity: "the patient",
    }, AT)).rejects.toMatchObject({ code: "release_approval_invalid" });

    expect(await db.select().from(labReportDeliveries)).toHaveLength(0);
  });

  /* ═════════════ A6 — THE SNAPSHOT IS FROZEN AND AN AMENDMENT IS A NEW VERSION ═════════════ */

  it("A6: the trigger refuses an UPDATE to a published snapshot", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    await expect(
      db.update(labReports).set({ snapshot: { tampered: true } })
        .where(eq(labReports.id, report.reportId)),
    ).rejects.toThrow(/lab_report_immutable/);
  });

  it("A6: amending TSH 2.5 → 9.9 makes 2 report rows and 2 result rows, v1 superseded", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT, values: { TSH: "2.5" } });
    const v1 = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);

    const [tsh] = await db.select({ id: labAnalytes.id }).from(labAnalytes)
      .where(eq(labAnalytes.code, "TSH"));
    const priorRow = (await db.select().from(labResults)
      .where(eq(labResults.analyteId, tsh!.id)))[0]!;
    expect(priorRow.valueNumeric).toBe("2.5000");

    const later = new Date(AT.getTime() + 3600_000);
    const corrected = await withTx(db, (tx) => amendResult(tx, fx.pathologist.actor, {
      resultId: priorRow.id, value: "9.9",
    }, later));

    const v2 = await amendReport(db, fx.pathologist.actor, {
      reportId: v1.reportId, reasonCode: "corrected_result",
    }, later);

    expect([v2.version, v2.priorVersionId]).toEqual([2, v1.reportId]);
    const reports = await db.select().from(labReports).where(eq(labReports.orderId, run.orderId));
    expect(reports).toHaveLength(2);
    expect(reports.find((r) => r.id === v1.reportId)!.status).toBe("superseded");
    expect(reports.find((r) => r.id === v2.reportId)!.amendmentReasonCode).toBe("corrected_result");

    /** BOTH result rows survive — the superseded one is still readable, which is the whole of DD13. */
    const rows = await db.select().from(labResults).where(eq(labResults.analyteId, tsh!.id));
    expect(rows).toHaveLength(2);
    const newRow = rows.find((r) => r.id === corrected.resultId)!;
    expect([newRow.supersedesResultId, newRow.valueNumeric, newRow.verificationStatus])
      .toEqual([priorRow.id, "9.9000", "verified"]);

    /** And version 2's snapshot carries the CORRECTED number, not the one it replaced. */
    const v2Row = reports.find((r) => r.id === v2.reportId)!;
    const snapshot = v2Row.snapshot as { panels: { analytes: { analyteCode: string; value: string }[] }[] };
    expect(snapshot.panels[0]!.analytes.find((a) => a.analyteCode === "TSH")!.value).toBe("9.9000");

    const amended = await eventsNamed("lab.report_amended");
    expect(amended).toHaveLength(1);
    expect(amended[0]!.payload).toMatchObject({ priorVersionId: v1.reportId, version: 2 });
  });

  it("a second FIRST publish is refused — a changed result is an amendment", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    await expect(publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT))
      .rejects.toMatchObject({ code: "report_not_publishable" });
  });

  it("an unfinished order is not publishable unless the caller asks for a PARTIAL report", async () => {
    const run = await runLabOrder(db, fx, ["TFT"], { at: AT, verify: false });
    await expect(publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT))
      .rejects.toMatchObject({ code: "report_not_publishable" });
  });

  /* ═══════════ A7 — THE READY NOTICE CARRIES NO CLINICAL CONTENT (02 J3 / C5) ═══════════ */

  it("A7: the enqueued PAYLOAD carries only the order number — no value, no analyte, no test", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT, values: { TSH: "9.0" } });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    expect(report.notificationId).not.toBeNull();

    /** ASSERTED ON THE ENQUEUED PAYLOAD, not on a template string — the row is what gets sent. */
    const [queued] = await db.select().from(notifications);
    expect(queued!.templateKey).toBe("patient_lab_report_ready");
    expect(queued!.params).toEqual({ orderNo: run.orderNo });
    expect([queued!.patientId, queued!.userId, queued!.refId])
      .toEqual([fx.patientId, null, report.reportId]);
    expect(JSON.stringify(queued!.params)).not.toContain("9.0");
    expect(JSON.stringify(queued!.params)).not.toContain("TSH");
  });

  it("A7: a SENSITIVE report enqueues nothing, publishes in_person only, and still emits the event", async () => {
    /** HBsAg is `sensitive` in the golden catalogue and needs no consent block (DD14 / 02 J3). */
    const run = await runLabOrder(db, fx, ["HBSAG"], { at: AT });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);

    expect(report.notificationId).toBeNull();
    expect(report.channels).toEqual(["in_person"]);
    expect(await db.select().from(notifications)).toHaveLength(0);

    /** 02 C5 — the laboratory HAS reported, whatever the gateway did or did not do. */
    const published = await eventsNamed("lab.report_published");
    expect(published).toHaveLength(1);
    expect(published[0]!.payload).toMatchObject({ reportId: report.reportId, channels: ["in_person"] });

    /** And a WhatsApp hand-over of it is refused by the STORED channel list. */
    await settleInvoice(db, cashier, fx.patientId, run.invoiceId, run.netPayablePaise, AT);
    await expect(printReport(db, fx.desk.actor, { reportId: report.reportId, channel: "whatsapp" }, AT))
      .rejects.toMatchObject({ code: "report_print_blocked" });
  });

  /* ═══════ A8 — THE ALIAS RULE AND ONE PHI ROW PER READ (DD14 / E17) ═══════ */

  it("A8: a sealed patient's report reads as the ALIAS for a clerk, and each read logs a row", async () => {
    await db.update(patients)
      .set({ isConfidential: true, alias: "Patient A" })
      .where(eq(patients.id, fx.patientId));
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);

    const before = (await db.select().from(phiAccessLog)).length;
    /** `lab_reception` holds `lab.results.read` and NOT `patients.confidential.read`. */
    const first = await getReport(db, fx.desk.actor, report.reportId, AT);
    expect(first.snapshot.patient.name).toBe("Patient A");

    const afterOne = await db.select().from(phiAccessLog);
    expect(afterOne.length).toBe(before + 1);
    const row = afterOne.at(-1)!;
    expect([row.surface, row.sealed, row.actorId, row.patientId])
      .toEqual(["lab.report", true, fx.desk.id, fx.patientId]);

    /** TWO READS ARE TWO DISCLOSURES — the row is per-read, never deduplicated. */
    await getReport(db, fx.desk.actor, report.reportId, AT);
    expect((await db.select().from(phiAccessLog)).length).toBe(before + 2);

    /**
     * THE SIGNED DOCUMENT ITSELF STILL CARRIES THE LEGAL NAME — the alias is applied at the READER
     * and to this caller, which is why a holder of `patients.confidential.read` sees the name.
     */
    const [stored] = await db.select().from(labReports).where(eq(labReports.id, report.reportId));
    expect((stored!.snapshot as { patient: { name: string } }).patient.name).toBe("Ram Kumar");
  });

  it("the doctor's encounter read logs `lab.results`, and a caller without the grant is refused", async () => {
    await runLabOrder(db, fx, ["TSH"], { at: AT });
    const before = (await db.select().from(phiAccessLog)).length;
    await listResultsForEncounter(db, fx.pathologist.actor, fx.encounterNo, AT);
    const rows = await db.select().from(phiAccessLog);
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)!.surface).toBe("lab.results");

    const stranger = await mkUser(db, "ward.clerk", ["nurse"]);
    await expect(listResultsForEncounter(db, stranger.actor, fx.encounterNo, AT))
      .rejects.toMatchObject({ code: "permission_denied" });
  });

  /* ══════════════════ THE CLOSE REVIEW'S FIXES, PINNED ══════════════════ */

  it("C1: the version history carries NO snapshot — a sealed name cannot leak through it", async () => {
    await db.update(patients).set({ isConfidential: true, alias: "Patient A" })
      .where(eq(patients.id, fx.patientId));
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);

    const versions = await reportVersions(db, run.orderId);
    expect(versions).toHaveLength(1);
    /**
     * `select()` with no projection returned every column including `snapshot`, which carries the
     * LEGAL name by design (E4). This reader has no alias rule and writes no PHI row, so the only
     * safe shape is one that cannot carry the document at all.
     */
    expect(Object.keys(versions[0]!).sort()).toEqual([
      "amendmentReasonCode", "channels", "partial", "printCount", "priorVersionId", "publishedAt",
      "reportId", "signedBy", "status", "version",
    ]);
    expect(JSON.stringify(versions)).not.toContain("Ram Kumar");
    expect(JSON.stringify(versions)).not.toContain("HMS-00000101-7");
  });

  it("M2: two concurrent amendments — one wins, the loser is refused report_not_amendable", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT, values: { TSH: "2.5" } });
    const v1 = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    const later = new Date(AT.getTime() + 3600_000);

    const settled = await Promise.allSettled([
      amendReport(db, fx.pathologist.actor, { reportId: v1.reportId, reasonCode: "clerical" }, later),
      amendReport(db, fx.pathologist.actor, { reportId: v1.reportId, reasonCode: "clerical" }, later),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = settled.find((r) => r.status === "rejected");
    expect((loser as PromiseRejectedResult).reason).toMatchObject({ code: "report_not_amendable" });

    /** EXACTLY ONE published version — two would let the counter and the ward read different pages. */
    const reports = await db.select().from(labReports).where(eq(labReports.orderId, run.orderId));
    expect(reports.filter((r) => r.status === "published")).toHaveLength(1);
    expect(reports).toHaveLength(2);
  });

  it("M4: a PARTIAL report that is later completed publishes as COMPLETE, not partial", async () => {
    /**
     * ═══ `partial` IS ITEM-GRAINED, AND THE FIRST VERSION OF THIS TEST GOT THAT WRONG (§9.4) ═══
     *
     * It used one TFT — three ANALYTES on ONE item — and signed one of them, expecting a partial
     * report. `buildSnapshot` includes an ITEM only when it is `completed`, and an item completes
     * only when its last analyte is signed, so a one-item order has no partial state at all: the
     * publish was refused *"a partial report of nothing is not a report"*, which is the code
     * correctly describing the fixture. **02 D7's real case is two tests and one analyser down**,
     * which is what this builds.
     */
    const run = await runLabOrder(db, fx, ["TSH", "GLUF"], { at: AT, verify: false });
    const rows = await db.select().from(labResults);
    const tshRow = rows.find((r) => r.orderItemId === run.itemIds[0]!)!;
    const glufRow = rows.find((r) => r.orderItemId === run.itemIds[1]!)!;
    /** The TSH is signed; the glucose analyser is down. */
    await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: tshRow.id }, AT);

    const v1 = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId, partial: true }, AT);
    expect(v1.partial).toBe(true);

    /** The analyser comes back the next morning and the glucose is signed. */
    await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: glufRow.id }, AT);
    const later = new Date(AT.getTime() + 3600_000);
    const v2 = await amendReport(db, fx.pathologist.actor, {
      reportId: v1.reportId, reasonCode: "added_analyte",
    }, later);

    /**
     * `partial` was carried forward from the prior version, so 02 D7's own path inverted itself: a
     * COMPLETE report stamped PARTIAL, and the A4 prints that word. It is derived from the contents.
     */
    expect(v2.partial).toBe(false);
    const [row] = await db.select().from(labReports).where(eq(labReports.id, v2.reportId));
    expect([row!.partial, (row!.snapshot as { partial: boolean }).partial]).toEqual([false, false]);
  });

  it("M8: a granted release is spent ONCE — the second hand-over needs a second decision", async () => {
    await registerLabApprovalTypes(db, fx.pathologist.actor);
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    const { approvalId } = await withTx(db, (tx) => requestApproval(tx, fx.desk.actor, {
      typeKey: RELEASE_UNPAID_APPROVAL_TYPE,
      subject: { type: "lab_report", id: run.orderId }, patientId: fx.patientId,
    }));
    await approveRequest(db, billingManager.actor, { approvalId, note: "carry it" });

    await releaseUnpaid(db, billingManager.actor, {
      reportId: report.reportId, approvalId, collectorIdentity: "the patient",
    }, AT);

    /**
     * `approvals` carries no expiry and nothing marked this consumed, so one grant made in August
     * for a ₹300 balance released the same order's report in September — by which time an amendment
     * had produced a v2 and more work had landed on the invoice.
     */
    await expect(releaseUnpaid(db, billingManager.actor, {
      reportId: report.reportId, approvalId, collectorIdentity: "an uncle",
    }, new Date(AT.getTime() + 86_400_000)))
      .rejects.toMatchObject({ code: "release_approval_invalid" });
    expect(await db.select().from(labReportDeliveries)).toHaveLength(1);
  });

  it("M7: two concurrent prints leave TWO register rows and a print count of TWO", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    await settleInvoice(db, cashier, fx.patientId, run.invoiceId, run.netPayablePaise, AT);

    await Promise.all([
      printReport(db, fx.desk.actor, {
        reportId: report.reportId, channel: "print", collectorIdentity: "the patient",
      }, AT),
      printReport(db, fx.desk.actor, {
        reportId: report.reportId, channel: "in_person", collectorIdentity: "a relative",
      }, AT),
    ]);
    expect(await db.select().from(labReportDeliveries)).toHaveLength(2);
    /** The count was `report.printCount + 1` read outside the transaction: both wrote 1. */
    const [row] = await db.select().from(labReports).where(eq(labReports.id, report.reportId));
    expect(row!.printCount).toBe(2);
  });

  /* ═══════════════ the item's own machine reaches its terminal state ═══════════════ */

  it("publishing takes the lab item to `published`, its terminal state", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    const [instance] = await db.select({ state: workflowInstances.currentState, status: workflowInstances.status })
      .from(workflowInstances).where(eq(workflowInstances.subjectId, run.itemIds[0]!));
    expect([instance!.state, instance!.status]).toEqual(["published", "completed"]);
  });
});
