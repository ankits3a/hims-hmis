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
  amendReport, deliveryRegister, getReport, listResultsForEncounter,
  listProvisionalResultsForEncounter, printReport, publishReport, releaseUnpaid, reportVersions,
  reportsForPatient,
} from "./reports";
import { amendResult, enterResult } from "./results";
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

  /* ═════ 17d T7 / D9 — AN AMENDMENT AFTER A RELEASE RE-HOLDS, AND THE APPROVAL IS SPENT ═════ */

  /**
   * ═══ 17c §8.9 CARRIED THIS AS A WORRY. IT IS ALREADY THE BEHAVIOUR — SO IT IS PINNED, NOT BUILT ═══
   *
   * The worry was a per-VERSION delivery fact meeting a per-ORDER approval: v1 released against an
   * unpaid balance, then amended, and v2 walking out on v1's decision. Reading the code, two
   * independent things already prevent it, and neither was written for this case:
   *
   * · `deliveryAllowed` holds no memory of a release. It recomputes from the ORDER GROUP's balance
   *   every time it is asked, so v2 is judged on the money as it stands, not on what was decided
   *   about v1 (`releasedByApproval` is a per-CALL option the caller must supply).
   * · The approval is spent by its DELIVERY ROW (`release_approval_invalid`), so the same decision
   *   cannot be presented twice — "a release is one decision about one hand-over".
   *
   * A behaviour nobody tested is a behaviour the next refactor may remove, and this one is money
   * leaving the building. So the test exists even though the code does not change: the correction
   * a hospital most wants to hand over free is the one it just corrected.
   */
  it("17d T7 / D9: v2 after a released v1 is HELD again, and v1's approval cannot release it", async () => {
    await registerLabApprovalTypes(db, fx.pathologist.actor);
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const v1 = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);

    const { approvalId } = await withTx(db, (tx) => requestApproval(tx, fx.desk.actor, {
      typeKey: RELEASE_UNPAID_APPROVAL_TYPE,
      subject: { type: "lab_report", id: run.orderId },
      patientId: fx.patientId,
      requestNote: "patient travelling tonight",
    }));
    await approveRequest(db, billingManager.actor, { approvalId, note: "carry the receivable" });
    const released = await releaseUnpaid(db, billingManager.actor, {
      reportId: v1.reportId, approvalId, collectorIdentity: "the patient, UHID card seen",
    }, AT);
    expect(released.verdict.reason).toBe("released_by_approval");

    /** The correction. The money has not moved — the balance is exactly what it was. */
    const later = new Date(AT.getTime() + 60 * 60_000);
    const v2 = await amendReport(db, fx.pathologist.actor, {
      reportId: v1.reportId, reasonCode: "clerical",
    }, later);
    expect(v2.version).toBe(2);

    /**
     * THE KILL: a verdict that remembered v1's release would read `released_by_approval` here and
     * the counter would hand v2 over against money nobody has paid.
     */
    const view = await getReport(db, fx.desk.actor, v2.reportId);
    expect(view.delivery.allowed).toBe(false);
    expect(view.delivery.reason).not.toBe("released_by_approval");
    expect(view.delivery.outstandingPaise).toBeGreaterThan(0);

    /** And v1's decision cannot be presented a second time for the new document. */
    await expect(releaseUnpaid(db, billingManager.actor, {
      reportId: v2.reportId, approvalId, collectorIdentity: "the patient",
    }, later)).rejects.toMatchObject({ code: "release_approval_invalid" });

    /** One delivery row in the register, still — the refused second hand-over wrote nothing. */
    expect(await db.select().from(labReportDeliveries)).toHaveLength(1);
  });
});

/**
 * ═══ PLAN 17c T5 — THE REPORT CENTRE'S READERS ═══
 */
describe("the report centre (17c T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  const AT = new Date("2026-08-29T05:30:00Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    await registerLabApprovalTypes(db, fx.pathologist.actor);
  });
  afterEach(() => { fx.unregister(); });

  it("A1: a sealed patient's reports read as the ALIAS, ONE phi_access_log row per call, and a HELD report carries NO snapshot", async () => {
    await db.update(patients).set({ isConfidential: true, alias: "Patient A" }).where(eq(patients.id, fx.patientId));
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);

    const before = (await db.select().from(phiAccessLog)).length;
    /** `lab_reception` holds `lab.reports.print` and NOT `patients.confidential.read`. */
    const view = await reportsForPatient(db, fx.desk.actor, fx.patientId, AT);
    expect(view.patient.display).toBe("Patient A");
    expect(view.patient.restricted).toBe(true);
    expect(view.reports).toHaveLength(1);
    const r = view.reports[0]!;
    expect([r.reportId, r.delivery.allowed, r.delivery.reason]).toEqual([report.reportId, false, "unpaid_invoices"]);
    /** THE KILL for the raw-select mutant: a held report sends no document, and no legal name anywhere. */
    expect(r.snapshot).toBeNull();
    expect(JSON.stringify(view)).not.toContain("Ram Kumar");
    const after = await db.select().from(phiAccessLog);
    expect(after.length).toBe(before + 1);
    expect([after.at(-1)!.surface, after.at(-1)!.sealed, after.at(-1)!.patientId]).toEqual(["lab.report", true, fx.patientId]);

    /** Settled ⇒ the snapshot travels, aliased; the read is logged again. */
    const cashier = await mkCashier(db, "lab.centre.cashier");
    await openSessionFor(db, cashier, 0);
    await settleInvoice(db, cashier, fx.patientId, run.invoiceId, run.netPayablePaise, AT);
    const settled = await reportsForPatient(db, fx.desk.actor, fx.patientId, AT);
    expect(settled.reports[0]!.delivery.allowed).toBe(true);
    expect(settled.reports[0]!.snapshot?.patient.name).toBe("Patient A");
    expect(JSON.stringify(settled)).not.toContain("Ram Kumar");
    expect((await db.select().from(phiAccessLog)).length).toBe(before + 2);
  });

  it("A2: the register lists the day's published reports with how each went out; a hand-over appears as a delivery row", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    const cashier = await mkCashier(db, "lab.centre.cashier2");
    await openSessionFor(db, cashier, 0);
    await settleInvoice(db, cashier, fx.patientId, run.invoiceId, run.netPayablePaise, AT);
    await printReport(db, fx.desk.actor, { reportId: report.reportId, channel: "print", collectorIdentity: "the patient" }, AT);

    const rows = await deliveryRegister(db, fx.desk.actor, "2026-08-29");
    expect(rows).toHaveLength(1);
    /** Test names are ALL OR NOTHING by `orders.read.restricted` (pass 1, F3): the counter holds none. */
    expect([rows[0]!.reportId, rows[0]!.patientDisplay, rows[0]!.orderables, rows[0]!.delivery.allowed])
      .toEqual([report.reportId, "Ram Kumar", [], true]);
    await grantPermissionToRole(db, fx.registry, "lab_reception", "orders.read.restricted");
    expect((await deliveryRegister(db, fx.desk.actor, "2026-08-29"))[0]!.orderables).toEqual(["TSH"]);
    expect(rows[0]!.deliveries.map((d) => [d.channel, d.collectorIdentity])).toEqual([["print", "the patient"]]);
    /** The ready notice was enqueued on publish (T7 A7) and its fate is on the row. */
    expect(rows[0]!.notice?.status).toBe("queued");
    /** Another day is another register. */
    expect(await deliveryRegister(db, fx.desk.actor, "2026-08-28")).toEqual([]);
    /** No snapshot on the register — it is a list, not a document. */
    expect(JSON.stringify(rows)).not.toContain("HMS-00000101-7");
  });

  it("A4 (pass 1, F2b): a HELD report RELEASED by a granted approval carries its page on the next read", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    expect((await reportsForPatient(db, fx.desk.actor, fx.patientId, AT)).reports[0]!.snapshot).toBeNull();
    const { approvalId } = await withTx(db, (tx) => requestApproval(tx, fx.desk.actor, {
      typeKey: RELEASE_UNPAID_APPROVAL_TYPE, subject: { type: "lab_report", id: run.orderId }, patientId: fx.patientId,
    }));
    const billingManager = await mkUser(db, "lab.centre.bm", ["billing_manager"]);
    await approveRequest(db, billingManager.actor, { approvalId, note: "carry the receivable" });
    await releaseUnpaid(db, fx.desk.actor, { reportId: report.reportId, approvalId, collectorIdentity: "the patient" }, AT);
    const after = await reportsForPatient(db, fx.desk.actor, fx.patientId, AT);
    /** THE KILL: before this fix the release spent the approval and the counter still had no page. */
    expect([after.reports[0]!.delivery.allowed, after.reports[0]!.delivery.reason, after.reports[0]!.snapshot !== null])
      .toEqual([true, "released_by_approval", true]);
    expect((await deliveryRegister(db, fx.desk.actor, "2026-08-29"))[0]!.delivery.reason).toBe("released_by_approval");
  });

  it("A3: a reader without the print permission is refused", async () => {
    const stranger = await mkUser(db, "lab.centre.stranger", []);
    await expect(reportsForPatient(db, stranger.actor, fx.patientId, AT)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(deliveryRegister(db, stranger.actor, "2026-08-29")).rejects.toMatchObject({ code: "permission_denied" });
  });

  /* ═════ 17d T5 / D6 — THE UNSIGNED NUMBERS, ON THEIR OWN DOOR (design EdgeCases #18) ═════ */

  /**
   * The board's case: *"Doctor wants the numbers by phone before the pathologist signs."* That is a
   * constant and legitimate request in an Indian hospital, and the honest answer is to show the
   * numbers with the word `unverified` on them rather than to pretend they do not exist.
   */
  it("17d T5: the provisional reader returns the UNSIGNED values, each stamped verified:false", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT, verify: false });
    expect(run.resultIds.length).toBeGreaterThan(0);

    /** The SIGNED door still says there is nothing — the pathologist has not signed. */
    expect(await listResultsForEncounter(db, fx.pathologist.actor, fx.encounterNo, AT)).toEqual([]);

    const provisional = await listProvisionalResultsForEncounter(db, fx.pathologist.actor, fx.encounterNo, AT);
    expect(provisional.length).toBeGreaterThan(0);
    // THE KILL: a row that does not carry its own unsignedness is one careless spread from
    // looking exactly like a signed one.
    expect(provisional.every((r) => r.verified === false)).toBe(true);
    // Who keyed it and when — what makes an unsigned number safe to look at.
    expect(provisional[0]!.enteredById).toBe(fx.bench.id);
    expect(provisional[0]!.enteredAt).toBe(AT.toISOString());
    expect(provisional[0]!.analyteCode).toBe("TSH");
  });

  it("17d T5: once SIGNED, the value leaves the provisional door and appears on the signed one", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    expect(run.resultIds.length).toBeGreaterThan(0);
    expect(await listProvisionalResultsForEncounter(db, fx.pathologist.actor, fx.encounterNo, AT)).toEqual([]);
    expect((await listResultsForEncounter(db, fx.pathologist.actor, fx.encounterNo, AT)).length)
      .toBeGreaterThan(0);
  });

  /**
   * ═══ THE MUTANT THAT SURVIVED, AND THE TEST IT ASKED FOR ═══
   *
   * `!= 'verified'` in place of `= 'unverified'` passed every other assertion in this file, because
   * nothing in the fixture — or in the product — ever writes an `autoverified` row: auto-verification
   * shipped with zero rules (17b DD8). The two filters are therefore indistinguishable on today's
   * data and would diverge the day the first rule is switched on, which is the worst moment to find
   * out. `verification_status` admits THREE values and the reader must mean the one it names.
   *
   * The row is written directly because there is no writer for it yet. `lab_results` enforces
   * `(verification_status = 'unverified') = (verified_by is null)`, so an autoverified row must
   * carry a verifier — which is exactly what makes it a SIGNED result rather than a provisional one.
   */
  it("17d T5: an AUTOVERIFIED result is signed by rule and is NOT provisional", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT, verify: false });
    await db.update(labResults)
      .set({ verificationStatus: "autoverified", verifiedBy: fx.pathologist.id, verifiedAt: AT })
      .where(eq(labResults.id, run.resultIds[0]!));

    const provisional = await listProvisionalResultsForEncounter(db, fx.pathologist.actor, fx.encounterNo, AT);
    // THE KILL: `!= 'verified'` returns the autoverified row and calls a signed value provisional.
    expect(provisional.map((r) => r.orderItemId)).not.toContain(
      (await db.select({ id: labResults.orderItemId }).from(labResults)
        .where(eq(labResults.id, run.resultIds[0]!)))[0]!.id,
    );
  });

  /**
   * A re-keyed value supersedes the row it replaces (`results.ts`'s M3 chain). A doctor reading
   * every attempt would be reading the laboratory's working-out rather than its current answer.
   */
  it("17d T5: a re-keyed value REPLACES its predecessor on the provisional door, never joins it", async () => {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT, verify: false, values: { TSH: "2.1" } });
    const first = await listProvisionalResultsForEncounter(db, fx.pathologist.actor, fx.encounterNo, AT);
    const tsh = first.find((r) => r.analyteCode === "TSH")!;
    expect(tsh.value).toBe("2.1000");

    const analyte = (await db.select({ id: labAnalytes.id }).from(labAnalytes)
      .where(eq(labAnalytes.code, "TSH")))[0]!;
    await enterResult(db, fx.bench.actor, {
      orderItemId: tsh.orderItemId, analyteId: analyte.id, value: "5.5", entryMode: "manual",
    }, AT);

    const after = await listProvisionalResultsForEncounter(db, fx.pathologist.actor, fx.encounterNo, AT);
    const tshRows = after.filter((r) => r.analyteCode === "TSH");
    expect(tshRows).toHaveLength(1); // THE KILL: 2 — the working-out shown as two live answers
    expect(tshRows[0]!.value).toBe("5.5000");
  });

  /** The same PHI rule as the signed read, under its OWN surface name — see `phi/audit.ts`. */
  it("17d T5: reading provisional values is logged under `lab.results.provisional`", async () => {
    await runLabOrder(db, fx, ["TSH"], { at: AT, verify: false });
    await listProvisionalResultsForEncounter(db, fx.pathologist.actor, fx.encounterNo, AT);
    const logged = await db.select().from(phiAccessLog)
      .where(eq(phiAccessLog.surface, "lab.results.provisional"));
    expect(logged).toHaveLength(1); // THE KILL: 0 — an unsigned disclosure nobody can audit
  });
});
