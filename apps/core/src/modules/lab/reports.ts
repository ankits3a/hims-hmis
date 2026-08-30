import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  approvals, labAnalytes, labItems, labOrderableAnalytes, labOrderables, labReportDeliveries,
  labReports, labResults, orderItems, orders, patients, users, workflowInstances,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { enqueueNotification } from "../../kernel/notify/enqueue";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { transition } from "../../kernel/workflow/instances";
/** Spec §4 — through the module's INDEX, never a deep path: `kernel/orders/read.ts` may reach into
 *  `display-name.ts` because the kernel has no index of its own to go through; a module may not. */
import { displayName, resolvePatientId } from "../patients";
import { RELEASE_UNPAID_APPROVAL_TYPE } from "./approval-types";
import { LabError } from "./errors";
import { deliveryAllowed } from "./interlock";
import {
  labReportAmended, labReportPrintBlocked, labReportPrinted, labReportPublished,
  labReportReleasedUnpaid,
} from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { DeliveryVerdict } from "./interlock";

/**
 * PLAN 17b T7 / DD13, DD14, DD6 — **THE DOCUMENT**: a versioned signed snapshot, the delivery
 * interlock in front of the hand-over, the release register, the ready notice, and the amendment.
 *
 * ═══ THE ONE SENTENCE THIS FILE MUST NOT GET WRONG ═══
 *
 * **`listResultsForEncounter` NEVER calls `deliveryAllowed`.** The doctor who ordered the test sees
 * every verified number on an unpaid self-pay order, and the critical-value call never consults the
 * interlock either. **The interlock holds a DOCUMENT, not a fact** — hiding a verified result from
 * the clinician who ordered it is the safety defect 02 O-1 forbids, and it is the one thing in this
 * module whose failure kills somebody rather than annoying them.
 *
 * ═══ A REPORT IS WRITTEN ONCE AND NEVER EDITED (DD13) ═══
 *
 * `lab_reports_immutable` refuses every UPDATE on a published row except `print_count` and `status`.
 * That is not belt-and-braces around a service rule — it is the rule, and this file has no edit
 * endpoint because there cannot be one. A correction is version n+1 carrying `prior_version_id`,
 * the superseded version stays readable, and "which report did the patient actually receive" stays
 * answerable for as long as the row exists.
 *
 * ═══ AND THE SNAPSHOT IS THE PATIENT AS THEY WERE (E4) ═══
 *
 * A merge next month does not rewrite a report printed today. The name, the UHID, the age and the
 * sex are copied into `snapshot` at publication, beside the results with the ranges they were
 * signed against — which is what makes a reprint of last year's report the same document rather
 * than today's data in last year's layout.
 */

export const LAB_REPORTS_PUBLISH = "lab.reports.publish";
export const LAB_REPORTS_PRINT = "lab.reports.print";
export const LAB_REPORTS_AMEND = "lab.reports.amend";
export const LAB_RESULTS_READ = "lab.results.read";
export const PATIENT_LAB_REPORT_READY = "patient_lab_report_ready";

/* ─────────────────────────────── the snapshot's shape ─────────────────────────────── */

export type ReportAnalyteLine = {
  analyteCode: string;
  nameEn: string;
  nameHi: string | null;
  value: string;
  unit: string | null;
  flag: string | null;
  refLow: string | null;
  refHigh: string | null;
  refText: string | null;
  refNote: string | null;
  deltaFlag: boolean;
  verifiedAt: string | null;
  /** DD11 — a night-mode release the pathologist has not yet reviewed prints as provisional. */
  pathologistReviewPending: boolean;
};

export type ReportPanel = {
  orderItemId: string;
  orderableCode: string;
  nameEn: string;
  nameHi: string | null;
  discipline: string;
  specimenNo: string | null;
  /** DD14 — a `sensitive` panel forces the whole report to in-person collection. */
  sensitive: boolean;
  analytes: ReportAnalyteLine[];
};

export type ReportSnapshot = {
  orderId: string;
  orderNo: string;
  encounterNo: string;
  serviceDate: string;
  /** E4 — the identity AS IT WAS. A merge afterwards does not rewrite a printed report. */
  patient: { id: string; uhid: string; name: string; sex: string; dob: string | null };
  orderingClinicianId: string | null;
  panels: ReportPanel[];
  signatory: { userId: string; username: string; signedAt: string };
  /** 02 D7 — a partial publish at 24 h; the rest follows as a later version. */
  partial: boolean;
  notes: string[];
};

export type PublishedReport = {
  reportId: string;
  orderId: string;
  version: number;
  partial: boolean;
  channels: string[];
  priorVersionId: string | null;
  notificationId: string | null;
};

/* ────────────────────────────────── the gates ────────────────────────────────── */

async function assertMay(exec: Db | Tx, actor: Actor, permission: string, act: string): Promise<void> {
  if (actor.type !== "user") {
    throw new LabError("user_actor_required", `a ${actor.type} actor may not ${act}`);
  }
  if (!(await hasPermission(exec as Db, actor.id, permission, "hospital"))) {
    throw new LabError("permission_denied", `${act} requires ${permission}`);
  }
}

/* ─────────────────────────────── building the snapshot ─────────────────────────────── */

type PanelSource = {
  orderItemId: string; serviceId: string; status: string; specimenNo: string | null;
};

async function buildSnapshot(
  tx: Tx,
  order: typeof orders.$inferSelect,
  actor: Actor,
  now: Date,
  /** PERMISSION to include an order with unfinished items — never the flag (pass 2, F1). */
  allowUnfinished: boolean,
): Promise<{ snapshot: ReportSnapshot; sensitive: boolean; itemIds: string[]; complete: boolean }> {
  const items = await tx
    .select({
      orderItemId: orderItems.id, serviceId: orderItems.serviceId, status: orderItems.status,
      instanceId: labItems.instanceId,
    })
    .from(orderItems)
    .innerJoin(labItems, eq(labItems.orderItemId, orderItems.id))
    .where(eq(orderItems.orderId, order.id))
    .orderBy(orderItems.createdAt);

  /**
   * A CANCELLED ITEM IS NOT ON THE REPORT. It was withdrawn, DD7 decided what it cost, and printing
   * it as "no result" would put a test the patient did not have on a document they hand to a
   * doctor.
   */
  const reportable: PanelSource[] = items
    .filter((i) => i.status !== "cancelled")
    .map((i) => ({ ...i, specimenNo: null }));
  if (reportable.length === 0) {
    throw new LabError(
      "report_not_publishable",
      `every test on order ${order.orderNo} was cancelled — there is nothing to report`,
    );
  }

  /**
   * ═══ A FULL REPORT NEEDS EVERY REPORTABLE ITEM `completed` (T7 A6's precondition) ═══
   *
   * `completed` is what `verifyResult` writes when the LAST analyte of an item is signed, so this
   * one check inherits the whole of T6 A3: a partial panel cannot reach a report by any route.
   * `partial: true` is 02 D7's deliberate 24-hour publish and it says so on the row, so a reader
   * can tell "the rest is coming" from "this is all there was".
   */
  const unfinished = reportable.filter((i) => i.status !== "completed");
  if (unfinished.length > 0 && !allowUnfinished) {
    throw new LabError(
      "report_not_publishable",
      `${unfinished.length} of ${reportable.length} tests on order ${order.orderNo} are not ` +
        "finished — publish the rest as a PARTIAL report, or wait",
      { unfinishedItemIds: unfinished.map((i) => i.orderItemId) },
    );
  }
  const included = allowUnfinished ? reportable.filter((i) => i.status === "completed") : reportable;
  if (included.length === 0) {
    throw new LabError(
      "report_not_publishable",
      `no test on order ${order.orderNo} has finished yet — a partial report of nothing is not a report`,
    );
  }

  const orderables = await tx.select().from(labOrderables)
    .where(inArray(labOrderables.serviceId, [...new Set(included.map((i) => i.serviceId))]));
  const orderableBy = new Map(orderables.map((o) => [o.serviceId, o]));

  const analyteRows = await tx
    .select({ serviceId: labOrderableAnalytes.serviceId, position: labOrderableAnalytes.position, analyte: labAnalytes })
    .from(labOrderableAnalytes)
    .innerJoin(labAnalytes, eq(labAnalytes.id, labOrderableAnalytes.analyteId))
    .where(inArray(labOrderableAnalytes.serviceId, [...orderableBy.keys()]))
    .orderBy(labOrderableAnalytes.position);

  const results = await tx
    .select().from(labResults)
    .where(and(
      inArray(labResults.orderItemId, included.map((i) => i.orderItemId)),
      eq(labResults.verificationStatus, "verified"),
    ))
    .orderBy(labResults.verifiedAt);

  const canonical = (await resolvePatientId(tx, order.patientId)) ?? order.patientId;
  const [patient] = await tx.select().from(patients).where(eq(patients.id, canonical));
  if (!patient) throw new LabError("unknown_item", `order ${order.orderNo} names no patient`);
  const [signatory] = await tx.select({ username: users.username })
    .from(users).where(eq(users.id, actor.id));

  const notes: string[] = [];
  const panels: ReportPanel[] = [];
  for (const item of included) {
    const orderable = orderableBy.get(item.serviceId)!;
    const mine = results.filter((r) => r.orderItemId === item.orderItemId);
    const lines: ReportAnalyteLine[] = [];
    for (const row of analyteRows.filter((a) => a.serviceId === item.serviceId)) {
      /**
       * THE LATEST VERIFIED ROW PER ANALYTE. A rerun writes a new row rather than editing the one
       * it doubts, so "the current value" is the last one signed — and `supersedes_result_id` on
       * the newer row is what an auditor follows back to the number it replaced.
       */
      const value = mine.filter((r) => r.analyteId === row.analyte.id).at(-1);
      if (!value) continue;
      if (value.refNote) notes.push(`${row.analyte.code}: ${value.refNote}`);
      lines.push({
        analyteCode: row.analyte.code,
        nameEn: row.analyte.nameEn,
        nameHi: row.analyte.nameHi,
        value: value.valueNumeric ?? value.valueText ?? value.valueCoded ?? "",
        unit: value.unit,
        flag: value.flag,
        refLow: value.refLow,
        refHigh: value.refHigh,
        refText: value.refText,
        refNote: value.refNote,
        deltaFlag: value.deltaFlag,
        verifiedAt: value.verifiedAt?.toISOString() ?? null,
        pathologistReviewPending: value.pathologistReviewPending,
      });
    }
    panels.push({
      orderItemId: item.orderItemId,
      orderableCode: orderable.code,
      nameEn: orderable.nameEn,
      nameHi: orderable.nameHi,
      discipline: orderable.discipline,
      specimenNo: item.specimenNo,
      sensitive: orderable.sensitive,
      analytes: lines,
    });
  }

  return {
    snapshot: {
      orderId: order.id,
      orderNo: order.orderNo,
      encounterNo: order.encounterNo,
      serviceDate: order.serviceDate,
      /**
       * THE SIGNED DOCUMENT CARRIES THE LEGAL NAME. It is the patient's own report and the
       * signatory is a pathologist: aliasing HERE would print a report nobody can match to a
       * person. The alias rule applies at the READER (`getReport`), which is where a caller who
       * may not see a sealed identity meets it (DD14 / T7 A8).
       */
      patient: {
        id: canonical, uhid: patient.uhid, name: patient.name,
        sex: patient.administrativeGender,
        dob: patient.dob ? patient.dob.toISOString().slice(0, 10) : null,
      },
      orderingClinicianId: order.orderingClinicianId,
      panels,
      signatory: { userId: actor.id, username: signatory?.username ?? actor.id, signedAt: now.toISOString() },
      partial: unfinished.length > 0,
      notes: [...new Set(notes)],
    },
    sensitive: panels.some((p) => p.sensitive),
    itemIds: included.map((i) => i.orderItemId),
    /** Every reportable item finished — what `partial` is DERIVED from (C.R. M4). */
    complete: unfinished.length === 0,
  };
}

/* ──────────────────────────────────── publish ──────────────────────────────────── */

export type PublishReportInput = {
  orderId: string;
  /** 02 D7 — publish what has finished at 24 h; the rest follows as a later version. */
  partial?: boolean;
};

/**
 * SIGN AND PUBLISH.
 *
 * `Db`-first, and for a reason A7 states as an assertion: **`lab.report_published` fires whatever
 * the enqueue does** (02 C5). The report is a fact about the laboratory; a WhatsApp gateway being
 * down at 03:00 is not, and a publish that rolled back because a message could not be queued would
 * make an outage at the messaging vendor into a laboratory that cannot report.
 */
export async function publishReport(
  db: Db,
  actor: Actor,
  input: PublishReportInput,
  now: Date = new Date(),
): Promise<PublishedReport> {
  await assertMay(db, actor, LAB_REPORTS_PUBLISH, "publish a lab report");
  const published = await withTx(db, (tx) => publishInTx(tx, actor, {
    orderId: input.orderId, allowUnfinished: input.partial === true,
    priorVersionId: null, amendmentReasonCode: null,
  }, now));
  return { ...published, notificationId: await notifyReady(db, published, now) };
}

type PublishInTxInput = {
  orderId: string;
  /**
   * ═══ PERMISSION TO PUBLISH WITH UNFINISHED ITEMS — NOT THE FLAG ON THE ROW (PASS 2, F1) ═══
   *
   * These were one field called `partial`, and M4's fix passed `false` from `amendReport` — which
   * silently closed the gate at `buildSnapshot`. An order published partial at 24 h (CBC signed,
   * LFT analyser down) could then never be AMENDED: correcting the haemoglobin and reissuing was
   * refused *"1 of 2 tests are not finished"*, so the version carrying the wrong value stayed the
   * published one. The two meanings are now two names, and the flag is derived from the contents.
   */
  allowUnfinished: boolean;
  priorVersionId: string | null;
  amendmentReasonCode: string | null;
};

type PublishedInTx = Omit<PublishedReport, "notificationId"> & {
  patientId: string; encounterNo: string; sensitive: boolean; orderNo: string;
};

async function publishInTx(
  tx: Tx,
  actor: Actor,
  input: PublishInTxInput,
  now: Date,
): Promise<PublishedInTx> {
  /**
   * THE ORDER ROW IS LOCKED BEFORE THE VERSION IS COMPUTED. `lab_reports_order_version_ux` would
   * refuse the second of two concurrent publishes as a raw unique violation at a counter; the lock
   * makes the loser wait and then read the version the winner wrote, which is the same shape
   * `closeHeaderIfDone` takes on the same table for the same reason.
   */
  const [order] = await tx.select().from(orders)
    .where(eq(orders.id, input.orderId)).for("update");
  if (!order || order.kind !== "lab") {
    throw new LabError("unknown_item", `no lab order ${input.orderId}`);
  }

  const existing = await tx.select().from(labReports)
    .where(eq(labReports.orderId, order.id)).orderBy(desc(labReports.version));
  const current = existing.find((r) => r.status === "published");
  if (input.priorVersionId === null) {
    if (current) {
      throw new LabError(
        "report_not_publishable",
        `order ${order.orderNo} already has a published report (v${current.version}) — a changed ` +
          "result is an AMENDMENT, never a second first version",
        { reportId: current.id, version: current.version },
      );
    }
  } else {
    /**
     * THE AMENDMENT'S PRIOR, RE-READ UNDER THE LOCK (C.R. M2). The loser of a two-amendment race
     * arrives here and finds the version it was asked to amend already `superseded` by the winner.
     */
    const prior = existing.find((r) => r.id === input.priorVersionId);
    if (!prior) throw new LabError("unknown_report", `no lab report ${input.priorVersionId}`);
    if (prior.status !== "published") {
      throw new LabError(
        "report_not_amendable",
        `report ${input.priorVersionId} is ${prior.status} — only the CURRENT published version is ` +
          "amended, and this one has already been replaced",
        { currentVersionId: current?.id ?? null },
      );
    }
  }

  const { snapshot, sensitive, itemIds, complete } =
    await buildSnapshot(tx, order, actor, now, input.allowUnfinished);
  /**
   * ═══ `partial` IS RECOMPUTED FROM WHAT WENT ON THE PAGE, NEVER CARRIED FORWARD (C.R. M4) ═══
   *
   * `amendReport` used to pass `prior.partial` through, so 02 D7's own path inverted itself: a CBC
   * published partial at 24 h while the LFT analyser was down, then amended once the LFT finished,
   * produced a COMPLETE report stamped PARTIAL — and the A4 prints that word. The flag is a
   * statement about THIS version's contents, so it is derived from them.
   */
  const partial = !complete;

  /**
   * ═══ DD14 — A `sensitive` PANEL FORCES IN-PERSON COLLECTION, ON THE ROW (02 J3) ═══
   *
   * An HIV or a pregnancy result is not sent to a telephone that may be shared with a family
   * (E46). The channels are STORED rather than decided at send time, so a later reader — 22c-F, the
   * counter, an auditor — reads the decision that was made at signature and not one recomputed
   * against a catalogue that may have moved.
   */
  const channels = sensitive ? ["in_person"] : ["print", "whatsapp", "in_person"];
  const version = (existing[0]?.version ?? 0) + 1;
  const reportId = newId();
  await tx.insert(labReports).values({
    id: reportId,
    orderId: order.id,
    version,
    status: "published",
    snapshot,
    signedBy: actor.id,
    signedAt: now,
    publishedAt: now,
    publishChannels: channels,
    amendmentReasonCode: input.amendmentReasonCode,
    priorVersionId: input.priorVersionId,
    partial,
  });

  if (input.priorVersionId !== null) {
    /** `status` is one of the two columns the immutability trigger lets move on a published row. */
    await tx.update(labReports).set({ status: "superseded" })
      .where(eq(labReports.id, input.priorVersionId));
  }

  /**
   * The lab item's own machine reaches its terminal state. `verified → published` declares
   * `pathologist, lab_reception`; an item already `published` (a second, amended version) has
   * nothing left to move and is skipped rather than throwing `unknown_transition`.
   */
  const instances = await tx
    .select({ id: workflowInstances.id, state: workflowInstances.currentState })
    .from(workflowInstances)
    .where(inArray(workflowInstances.subjectId, itemIds));
  for (const instance of instances) {
    if (instance.state !== "verified") continue;
    await transition(tx, instance.id, "published", actor);
  }

  const event = input.priorVersionId === null ? labReportPublished : labReportAmended;
  await appendEvent(tx, input.priorVersionId === null
    ? labReportPublished.make({
        actor, patientId: snapshot.patient.id, encounterId: order.encounterNo, correlationId: order.id,
        payload: {
          reportId, orderId: order.id, patientId: snapshot.patient.id, version,
          /** THE DERIVED FLAG (pass 2, F11) — the event and the document must not disagree. */
          partial, channels, signedBy: actor.id,
        },
      })
    : labReportAmended.make({
        actor, patientId: snapshot.patient.id, encounterId: order.encounterNo, correlationId: order.id,
        payload: {
          reportId, priorVersionId: input.priorVersionId, orderId: order.id, version,
          reasonCode: input.amendmentReasonCode ?? "corrected_result", amendedBy: actor.id,
        },
      }));
  void event;

  return {
    reportId, orderId: order.id, version, partial, channels,
    priorVersionId: input.priorVersionId, patientId: snapshot.patient.id,
    encounterNo: order.encounterNo, sensitive, orderNo: order.orderNo,
  };
}

/**
 * ═══ THE READY NOTICE — TOKEN-ONLY, AND OUTSIDE THE PUBLISHING TRANSACTION (T7 A7 / 02 C5) ═══
 *
 * It carries **no result values and no analyte names**: the body says the report is ready and where
 * to collect it (R-020 / 02 J3), because there is no patient-facing deep link before 22c-F and a
 * message that carried the number would put a haemoglobin on a lock screen.
 *
 * **A `sensitive` report is not messaged at all** — its channels are `['in_person']` and this is
 * where that decision is honoured rather than merely recorded.
 *
 * ═══ SPIKE S12, ANSWERED BY READING THE CODE: THE AMENDMENT NOTICE GETS THROUGH ═══
 *
 * `enqueueNotification`'s `dedupeKey` is CALLER-SUPPLIED and its uniqueness is a plain
 * `onConflictDoNothing` on that column. An amendment is a NEW `lab_reports` row with its own id, so
 * a key derived from the REPORT id (not the order id) is distinct by construction and R-018's
 * re-notification is delivered. DD24's fallback — record the finding and tell the counter to
 * telephone — is therefore NOT needed, and that is a fact read off `enqueue.ts:117-127` rather
 * than assumed.
 *
 * A failure here never unpublishes: the enqueue runs on its own transaction and its exception is
 * swallowed with the reason recorded, because 02 C5 says the laboratory has reported whatever the
 * gateway did.
 */
async function notifyReady(db: Db, published: PublishedInTx, now: Date): Promise<string | null> {
  if (published.sensitive) return null;
  try {
    const enqueued = await withTx(db, (tx) => enqueueNotification(tx, {
      templateKey: PATIENT_LAB_REPORT_READY,
      params: { orderNo: published.orderNo },
      dedupeKey: `lab_report_ready:${published.reportId}`,
      occurredAt: now,
      patientId: published.patientId,
      refType: "lab_report",
      refId: published.reportId,
    }));
    return enqueued?.id ?? null;
  } catch {
    // 02 C5 — the laboratory has reported. A messaging gateway is not a laboratory.
    return null;
  }
}

/* ──────────────────────────────────── amend ──────────────────────────────────── */

export type AmendReportInput = {
  reportId: string;
  /** R-018 — a reason CATEGORY, never free text on a re-notification. */
  reasonCode: "corrected_result" | "corrected_demographics" | "added_analyte" | "clerical";
};

/**
 * AMEND — version n+1, `prior_version_id` naming n, and n marked `superseded`.
 *
 * There is no edit endpoint and this is not one: the superseded version stays readable for ever,
 * which is what makes "which report did the patient receive" answerable after the fact. R-018's
 * re-notification is sent because S12 says it will not be swallowed (see `notifyReady`).
 */
export async function amendReport(
  db: Db,
  actor: Actor,
  input: AmendReportInput,
  now: Date = new Date(),
): Promise<PublishedReport> {
  await assertMay(db, actor, LAB_REPORTS_AMEND, "amend a lab report");

  /**
   * ═══ THE ORDER IS READ FIRST ONLY TO FIND IT; THE **DECISION** IS MADE UNDER THE LOCK (C.R. M2) ═══
   *
   * This function used to read `prior` here, outside any transaction, refuse a non-published prior,
   * and then hand `publishInTx` a `priorVersionId` — which makes `publishInTx` skip its own
   * "already published" refusal. Two registrars amending v1 at the same moment therefore both
   * passed the check, both took the order lock in turn, and produced **v2 and v3 BOTH `published`**,
   * each superseding v1. Every CHECK constraint is satisfied by that state and `printReport`
   * accepts either, so the counter hands over one version while the ward reads another.
   *
   * `publishInTx` now resolves the prior version ITSELF, after `FOR UPDATE`. The loser of the race
   * reads the winner's v2, finds the report it was asked to amend already `superseded`, and is
   * refused `report_not_amendable` — which is the honest answer to "amend a version somebody else
   * has already replaced".
   */
  const [found] = await db.select({ orderId: labReports.orderId })
    .from(labReports).where(eq(labReports.id, input.reportId));
  if (!found) throw new LabError("unknown_report", `no lab report ${input.reportId}`);

  /**
   * `allowUnfinished: true` — an AMENDMENT is never blocked by a sibling that has not finished
   * (F1). It is a correction to what is already on the page, and the derived `partial` below says
   * whether the page is now everything.
   */
  const published = await withTx(db, (tx) => publishInTx(tx, actor, {
    orderId: found.orderId, allowUnfinished: true,
    priorVersionId: input.reportId, amendmentReasonCode: input.reasonCode,
  }, now));
  return { ...published, notificationId: await notifyReady(db, published, now) };
}

/* ──────────────────────────────────── print ──────────────────────────────────── */

export type PrintReportInput = {
  reportId: string;
  /**
   * `doctor_screen` is deliberately NOT here (close review m2). `publishInTx` only ever stores
   * `['in_person']` or `['print','whatsapp','in_person']`, so the channel could never match the
   * stored list and the refusal came back saying *"a confidentiality-class result is collected in
   * person"* — the wrong reason, about a report that is not sensitive. A doctor reading on screen
   * goes through `listResultsForEncounter`, which is not a hand-over and writes no delivery row.
   */
  channel: "print" | "whatsapp" | "in_person";
  /** 02 J2 — WHO took the report away. Required for a physical hand-over (T7 A9). */
  collectorIdentity?: string;
  /** DD6 — a GRANTED `lab_release_unpaid` approval releases an unsettled order's document. */
  approvalId?: string;
};

export type PrintedReport = {
  reportId: string;
  deliveryId: string;
  channel: string;
  printCount: number;
  verdict: DeliveryVerdict;
};

/**
 * HAND THE DOCUMENT OVER — the ONE place the interlock is consulted.
 *
 * `Db`-first, because `lab.report_print_blocked` is an event about a REFUSAL and a refusal rolls
 * its own transaction back (F20's mechanism, and F27's). A counter that is told "your report is
 * held" leaves a row in the register saying so; without the `Db` lane it would leave nothing, and
 * "how often does the interlock actually fire" is the first question anyone reviewing DD6 asks.
 */
export async function printReport(
  db: Db,
  actor: Actor,
  input: PrintReportInput,
  now: Date = new Date(),
): Promise<PrintedReport> {
  await assertMay(db, actor, LAB_REPORTS_PRINT, "print or send a lab report");

  const [report] = await db.select().from(labReports).where(eq(labReports.id, input.reportId));
  if (!report) throw new LabError("unknown_report", `no lab report ${input.reportId}`);
  if (report.status !== "published") {
    throw new LabError(
      "report_not_publishable",
      `report ${input.reportId} is ${report.status} — a superseded version is history, not a ` +
        "document to hand over; print the current one",
    );
  }

  /**
   * 02 J2 / T7 A9 — A PHYSICAL HAND-OVER NAMES ITS COLLECTOR. `lab_report_deliveries_collector_ck`
   * refuses it at the table too; this refusal exists so the counter reads a sentence rather than a
   * constraint name, and so nothing is written before the question is answered.
   */
  if ((input.channel === "print" || input.channel === "in_person") && !input.collectorIdentity?.trim()) {
    throw new LabError(
      "collector_identity_required",
      "a printed or hand-delivered report records WHO collected it — a cashier printing for a " +
        "friend is exactly what this register exists to make visible (E42)",
    );
  }

  /**
   * ═══ DD14 — A `sensitive` REPORT IS COLLECTED IN PERSON, WHATEVER THE CALLER ASKS FOR ═══
   *
   * The channels were decided and STORED at signature, so this compares against the row rather than
   * re-deriving from a catalogue that may have moved since (E41's shape, one table over).
   */
  if (!report.publishChannels.includes(input.channel)) {
    throw new LabError(
      "report_print_blocked",
      `report ${input.reportId} was published for ${report.publishChannels.join(", ")} only — a ` +
        "confidentiality-class result is collected in person (02 J3)",
      { channels: report.publishChannels },
    );
  }

  /**
   * The approval is VALIDATED here for the refusal's sake — a caller with a wrong approval should
   * be told before anything else happens — and SPENT inside the write transaction below (pass 2,
   * F10), because a check on `db` and an insert in a later transaction is a TOCTOU that two clerks
   * releasing the same held report at the same moment both pass.
   */
  const releasedByApproval = input.approvalId === undefined
    ? false
    : await assertReleaseApproval(db, input.approvalId, report.orderId);

  const verdict = await deliveryAllowed(db, report.orderId, { releasedByApproval });
  const snapshot = report.snapshot as ReportSnapshot;

  if (!verdict.allowed) {
    /** THE REFUSAL IS EVENTED ON ITS OWN TRANSACTION — see this function's header (F20/F27). */
    await withTx(db, (tx) => appendEvent(tx, labReportPrintBlocked.make({
      actor,
      patientId: snapshot.patient.id,
      encounterId: snapshot.encounterNo,
      correlationId: report.orderId,
      payload: {
        reportId: report.id, orderId: report.orderId, reason: verdict.reason,
        /**
         * THE EVENT'S FIELD IS CALLED `unpaidLineIds` AND IT CARRIES INVOICE IDS (§9.2 F36).
         * DD23 ruled the interlock invoice-grained AFTER `events.ts` was written, and `events.ts`
         * is T2's frozen file. Naming the invoices is the honest payload; renaming the field is
         * the next phase that may edit it.
         */
        unpaidLineIds: verdict.unpaidInvoiceIds,
      },
    })));
    throw new LabError(
      "report_print_blocked",
      `report ${input.reportId} is held: ${verdict.unpaidInvoiceIds.length} invoice(s) carrying ` +
        `this order's tests are unsettled (₹${(verdict.outstandingPaise / 100).toFixed(2)} outstanding)`,
      { unpaidInvoiceIds: verdict.unpaidInvoiceIds, outstandingPaise: verdict.outstandingPaise },
    );
  }

  return await withTx(db, async (tx) => {
    if (releasedByApproval) {
      /**
       * ═══ SERIALISED ON THE APPROVAL, AND RE-CHECKED UNDER IT (PASS 2, F10) ═══
       *
       * `pg_advisory_xact_lock` is the house pattern (`desk.ts`'s group guard, `kernel/ops/mode.ts`)
       * and it is taken FIRST, so two clerks releasing the same held report queue rather than both
       * reading zero deliveries and both handing the document over on one decision.
       */
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.approvalId!}))`);
      await assertReleaseApproval(tx, input.approvalId!, report.orderId);
    }
    const deliveryId = newId();
    await tx.insert(labReportDeliveries).values({
      id: deliveryId,
      reportId: report.id,
      channel: input.channel,
      deliveredBy: actor.id,
      collectorIdentity: input.collectorIdentity?.trim() ?? null,
      /** The approval is recorded on the DELIVERY row — the release is a fact about a hand-over. */
      approvalId: releasedByApproval ? input.approvalId! : null,
      at: now,
    });
    /**
     * `print_count` is the second column the immutability trigger lets move on a published row —
     * and it is incremented IN SQL, not read-then-written (C.R. M7). `report` was read on `db`
     * before this transaction opened, so `report.printCount + 1` made two counter staff printing
     * the same report both read 0 and both write 1: two rows in the register and a count of one.
     */
    const [bumped] = await tx.update(labReports)
      .set({ printCount: sql`${labReports.printCount} + 1` })
      .where(eq(labReports.id, report.id))
      .returning({ printCount: labReports.printCount });

    await appendEvent(tx, labReportPrinted.make({
      actor,
      patientId: snapshot.patient.id,
      encounterId: snapshot.encounterNo,
      correlationId: report.orderId,
      payload: {
        reportId: report.id, orderId: report.orderId, deliveryId, channel: input.channel,
        collectorIdentity: input.collectorIdentity?.trim() ?? null, printedBy: actor.id,
      },
    }));

    if (releasedByApproval) {
      /**
       * ═══ THE DUES ROW IS UNTOUCHED — IT WAS ALREADY THE RECEIVABLE (T7 A4) ═══
       *
       * No credit note, no allocation, no write to `invoices`. `billing_manager` decided to carry a
       * receivable, not to forgive one, and a release that quietly wrote off the balance would make
       * the interlock a discount mechanism — 02 O-1's opposite.
       */
      await appendEvent(tx, labReportReleasedUnpaid.make({
        actor,
        patientId: snapshot.patient.id,
        correlationId: report.orderId,
        payload: {
          reportId: report.id, orderId: report.orderId, approvalId: input.approvalId!,
          releasedBy: actor.id, outstandingPaise: verdict.outstandingPaise,
        },
      }));
    }

    return {
      reportId: report.id, deliveryId, channel: input.channel,
      printCount: bumped?.printCount ?? report.printCount + 1, verdict,
    };
  });
}

/** DD6 — the release is a GRANTED `lab_release_unpaid` approval **about this order** and nothing else. */
async function assertReleaseApproval(
  exec: Db | Tx,
  approvalId: string,
  orderId: string,
): Promise<boolean> {
  const db = exec as Db;
  const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!approval) {
    throw new LabError("release_approval_invalid", `no approval ${approvalId}`);
  }
  if (approval.typeKey !== RELEASE_UNPAID_APPROVAL_TYPE) {
    throw new LabError(
      "release_approval_invalid",
      `approval ${approvalId} is a ${approval.typeKey} — the interlock is released by a ` +
        `${RELEASE_UNPAID_APPROVAL_TYPE}, and an approval for one thing is not an approval for another`,
    );
  }
  if (approval.status !== "granted") {
    throw new LabError(
      "release_approval_invalid",
      `approval ${approvalId} is ${approval.status} — a pending request releases nothing`,
    );
  }
  /**
   * THE SUBJECT IS THIS ORDER. Without this, one granted release would print every held report in
   * the hospital, which is the whole control undone by an id a caller chooses.
   */
  if (approval.subjectId !== orderId) {
    throw new LabError(
      "release_approval_invalid",
      `approval ${approvalId} was granted for ${approval.subjectId}, not for order ${orderId}`,
    );
  }

  /**
   * ═══ AND IT IS SPENT ONCE (CLOSE REVIEW M8) ═══
   *
   * `approvals` carries no expiry and nothing marked this consumed, so a grant made in August for a
   * ₹300 balance still released the same order's report in September — by which time an amendment
   * had produced a v2 and ₹4,000 of add-on lab work had landed on the same invoice. DD6 describes a
   * one-time managerial decision to carry a receivable; what shipped was a standing permanent
   * exemption keyed to an order id.
   *
   * The release register IS the record of use: a delivery row carrying this `approval_id` means the
   * decision has been acted on. A second hand-over needs a second decision, which is what
   * `billing_manager` is being asked for.
   */
  const [spent] = await db
    .select({ id: labReportDeliveries.id, at: labReportDeliveries.at })
    .from(labReportDeliveries)
    .where(eq(labReportDeliveries.approvalId, approvalId))
    .limit(1);
  if (spent) {
    throw new LabError(
      "release_approval_invalid",
      `approval ${approvalId} was already used to hand this order's report over at ` +
        `${spent.at.toISOString()} — a release is one decision about one hand-over, and the balance ` +
        "may have moved since",
      { deliveryId: spent.id },
    );
  }
  return true;
}

export type ReleaseUnpaidInput = {
  reportId: string;
  approvalId: string;
  channel?: "print" | "in_person";
  collectorIdentity: string;
};

/**
 * The named path DD6 gives `billing_manager`'s decision. It is `printReport` with the approval
 * rather than a second writer, because two ways to hand a report over is two release registers.
 */
export async function releaseUnpaid(
  db: Db,
  actor: Actor,
  input: ReleaseUnpaidInput,
  now: Date = new Date(),
): Promise<PrintedReport> {
  return await printReport(db, actor, {
    reportId: input.reportId,
    channel: input.channel ?? "print",
    collectorIdentity: input.collectorIdentity,
    approvalId: input.approvalId,
  }, now);
}

/* ──────────────────────────────────── readers ──────────────────────────────────── */

export type ReportView = {
  reportId: string;
  orderId: string;
  version: number;
  status: string;
  partial: boolean;
  channels: string[];
  printCount: number;
  priorVersionId: string | null;
  amendmentReasonCode: string | null;
  publishedAt: string | null;
  snapshot: ReportSnapshot;
  /** What the counter may do with it right now — the interlock, read but never applied to a fact. */
  delivery: DeliveryVerdict;
};

/**
 * ═══ ONE REPORT, WITH THE ALIAS RULE AND ONE `phi_access_log` ROW PER READ (T7 A8 / DD14) ═══
 *
 * A sealed patient's legal name never leaves this function for a caller without
 * `patients.confidential.read`; the fallback for a confidential row with no alias is a dash and
 * never the name — `display-name.ts`'s rule, applied rather than re-decided.
 *
 * **The log is written for every ACCEPTED read, including one that shows an alias.** Two reads are
 * two disclosures, so the row is per-read rather than deduplicated — the same rule
 * `kernel/orders/read.ts` follows and for the same reason: "who looked at this report" is the only
 * question the log exists to answer.
 */
export async function getReport(
  db: Db,
  actor: Actor,
  reportId: string,
  now: Date = new Date(),
): Promise<ReportView> {
  await assertMay(db, actor, LAB_RESULTS_READ, "read a lab report");

  const [report] = await db.select().from(labReports).where(eq(labReports.id, reportId));
  if (!report) throw new LabError("unknown_report", `no lab report ${reportId}`);

  const snapshot = report.snapshot as ReportSnapshot;
  /**
   * THE CANONICAL PATIENT, not the snapshotted id (close review m3). The snapshot freezes the
   * identity as it was at signature (E4) and a merge afterwards does not rewrite it — but the
   * CONFIDENTIALITY FLAG is a fact about the person NOW. A patient sealed only on the surviving
   * record would have had their name disclosed from the losing row's `is_confidential = false`.
   */
  const canonical = (await resolvePatientId(db, snapshot.patient.id)) ?? snapshot.patient.id;
  const [patient] = await db
    .select({ name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential })
    .from(patients).where(eq(patients.id, canonical));
  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");

  await recordPhiAccess(db, {
    actor,
    patientId: canonical,
    surface: "lab.report",
    encounterId: snapshot.encounterNo,
    sealed: patient?.isConfidential ?? false,
    now,
  });

  return {
    reportId: report.id,
    orderId: report.orderId,
    version: report.version,
    status: report.status,
    partial: report.partial,
    channels: report.publishChannels,
    printCount: report.printCount,
    priorVersionId: report.priorVersionId,
    amendmentReasonCode: report.amendmentReasonCode,
    publishedAt: report.publishedAt?.toISOString() ?? null,
    /**
     * THE NAME IS RE-RENDERED OVER THE SNAPSHOT, NEVER READ OUT OF IT. The snapshot stores the
     * legal name (it is the signed document); the alias decision belongs to THIS read and to this
     * caller, so a clerk opening a sealed patient's report sees the alias even though the document
     * itself carries the name.
     */
    snapshot: {
      ...snapshot,
      patient: {
        ...snapshot.patient,
        name: patient ? displayName(patient, canSeeConfidential) : snapshot.patient.name,
      },
    },
    delivery: await deliveryAllowed(db, report.orderId),
  };
}

export type EncounterResultRow = {
  orderId: string;
  orderItemId: string;
  orderableCode: string;
  orderableName: string;
  analyteCode: string;
  analyteName: string;
  value: string;
  unit: string | null;
  flag: string | null;
  refLow: string | null;
  refHigh: string | null;
  refText: string | null;
  deltaFlag: boolean;
  verifiedAt: string | null;
  pathologistReviewPending: boolean;
};

/**
 * ═══ THE DOCTOR'S READ, AND IT NEVER CONSULTS THE INTERLOCK (T7 A3 / 02 O-1) ═══
 *
 * Verified results for this visit's lab orders, returned for an UNPAID self-pay order exactly as
 * for a settled one. The interlock holds a DOCUMENT the patient takes away; it has never held a
 * fact from the clinician who ordered the test, and a version of this function that checked
 * `deliveryAllowed` would be the safety defect DD6 is written to avoid.
 *
 * It returns VERIFIED rows only — an unverified number is a working note, and a consult screen that
 * showed it would put an unsigned value in front of a prescriber.
 */
export async function listResultsForEncounter(
  db: Db,
  actor: Actor,
  encounterNo: string,
  now: Date = new Date(),
): Promise<EncounterResultRow[]> {
  await assertMay(db, actor, LAB_RESULTS_READ, "read lab results");

  const rows = await db
    .select({
      orderId: orders.id,
      patientId: orders.patientId,
      orderItemId: orderItems.id,
      orderableCode: labOrderables.code,
      orderableName: labOrderables.nameEn,
      analyteCode: labAnalytes.code,
      analyteName: labAnalytes.nameEn,
      result: labResults,
    })
    .from(labResults)
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(labOrderables, eq(labOrderables.serviceId, orderItems.serviceId))
    .innerJoin(labAnalytes, eq(labAnalytes.id, labResults.analyteId))
    .where(and(
      eq(orders.encounterNo, encounterNo),
      eq(labResults.verificationStatus, "verified"),
    ))
    .orderBy(labResults.verifiedAt);

  /**
   * THE LOG IS WRITTEN WHEN THERE IS A PATIENT TO NAME. An encounter with no lab results discloses
   * nothing about a person this function can identify, so there is nothing to record — a property
   * of the query, not an exemption (`kernel/orders/read.ts`'s `listOrdersForEncounter`, same shape).
   */
  const subject = rows[0];
  if (subject) {
    const canonical = (await resolvePatientId(db, subject.patientId)) ?? subject.patientId;
    const [sealed] = await db.select({ isConfidential: patients.isConfidential })
      .from(patients).where(eq(patients.id, canonical));
    await recordPhiAccess(db, {
      actor, patientId: canonical, surface: "lab.results", encounterId: encounterNo,
      sealed: sealed?.isConfidential ?? false, now,
    });
  }

  return rows.map((r) => ({
    orderId: r.orderId,
    orderItemId: r.orderItemId,
    orderableCode: r.orderableCode,
    orderableName: r.orderableName,
    analyteCode: r.analyteCode,
    analyteName: r.analyteName,
    value: r.result.valueNumeric ?? r.result.valueText ?? r.result.valueCoded ?? "",
    unit: r.result.unit,
    flag: r.result.flag,
    refLow: r.result.refLow,
    refHigh: r.result.refHigh,
    refText: r.result.refText,
    deltaFlag: r.result.deltaFlag,
    verifiedAt: r.result.verifiedAt?.toISOString() ?? null,
    pathologistReviewPending: r.result.pathologistReviewPending,
  }));
}

export type ReportVersionRow = {
  reportId: string;
  version: number;
  status: string;
  partial: boolean;
  channels: string[];
  printCount: number;
  priorVersionId: string | null;
  amendmentReasonCode: string | null;
  publishedAt: string | null;
  signedBy: string | null;
};

/**
 * ═══ THE VERSION HISTORY — AND IT RETURNS NO SNAPSHOT (CLOSE REVIEW C1) ═══
 *
 * This function used to be `select()` with no projection, which returns every column INCLUDING
 * `snapshot` — and `buildSnapshot` deliberately stores the patient's **legal** name, because it is
 * the signed document. `getReport` is where the alias rule and the PHI log live (T7 A8), and this
 * was a second reader on the same controller that had neither: a technologist holding
 * `lab.results.read` and not `patients.confidential.read` read a sealed patient's legal name, UHID
 * and date of birth, and nothing was written to `phi_access_log`.
 *
 * **That is §2.140's own shape** — a disclosure removed at one reader and left standing on a sibling
 * added in the same commit — and it is the shape 17a's close pass 2 found twice. The columns below
 * are named EXPLICITLY rather than excluded, so a column added to `lab_reports` later cannot join
 * this response by default. **A caller that wants the document calls `getReport` and gets logged.**
 */
export async function reportVersions(
  exec: Db | Tx,
  orderId: string,
): Promise<ReportVersionRow[]> {
  const rows = await (exec as Db)
    .select({
      reportId: labReports.id, version: labReports.version, status: labReports.status,
      partial: labReports.partial, channels: labReports.publishChannels,
      printCount: labReports.printCount, priorVersionId: labReports.priorVersionId,
      amendmentReasonCode: labReports.amendmentReasonCode, publishedAt: labReports.publishedAt,
      signedBy: labReports.signedBy,
    })
    .from(labReports)
    .where(eq(labReports.orderId, orderId)).orderBy(desc(labReports.version));
  return rows.map((r) => ({ ...r, publishedAt: r.publishedAt?.toISOString() ?? null }));
}
