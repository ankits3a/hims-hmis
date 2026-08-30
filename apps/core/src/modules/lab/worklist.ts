import { and, asc, eq, inArray } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  labAnalytes, labItems, labOrderableAnalytes, labOrderables, labReports, labResults,
  labSpecimenItems, labSpecimens, orderItems, orders, patients, workflowInstances,
} from "../../kernel/db/schema";
import { displayName } from "../patients";
import { LabError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 17b T8 — **THE TWO WORKLISTS THE BENCH AND THE VERIFY SCREENS READ.**
 *
 * ═══ A FILE T8's FILES LIST DOES NOT NAME, DISCLOSED (17a F9's precedent) ═══
 *
 * Both screens need "the work in front of me" and neither is testing how it is assembled. Putting
 * the query in a controller would put it in TWO controllers — `lab-bench` and `lab-verify` — which
 * is §2.54's mechanism with a patient's worklist as the fact that drifts.
 *
 * ═══ EVERY ROW IS KEYED OFF THE **ENVELOPE**, WHICH IS WHAT MAKES F37 HARMLESS ═══
 *
 * `order_items.status = 'in_progress'` is the gate on both lists. A lab instance stranded at
 * `resulted` under a CANCELLED envelope item — the state `cancelLabItem` records when the pinned
 * definition has no edge to leave (§9.2 F37) — is invisible here, and to the sweeps, for the same
 * reason. Untidy, not dangerous, and this is the file that makes that claim true.
 *
 * ═══ THE PATIENT'S NAME IS THE ONE THIS VIEWER MAY SEE ═══
 *
 * `displayName` with the caller's own `patients.confidential.read`, resolved once per call. A
 * worklist that rendered a sealed patient's legal name for a technologist would be the leak the
 * alias rule exists to stop, one screen away from the reader that gets it right.
 */

export type WorklistRow = {
  orderItemId: string;
  orderId: string;
  orderNo: string;
  encounterNo: string;
  patientId: string;
  patientDisplay: string;
  serviceId: string;
  orderableCode: string;
  orderableName: string;
  discipline: string;
  priority: string;
  /** The lab machine's own stage — `accessioned`, `in_analysis`, `resulted`, `verified`. */
  state: string;
  specimenNo: string | null;
  tatStartedAt: string | null;
  analytes: {
    analyteId: string; code: string; nameEn: string; unit: string | null; resultType: string;
    resultId: string | null; value: string | null; flag: string | null;
    refLow: string | null; refHigh: string | null; refText: string | null;
    verificationStatus: string | null; enteredById: string | null;
    pathologistReviewPending: boolean;
  }[];
};

const WORKLIST_READ = "lab.worklist.read";

/**
 * THE BENCH'S LIST — everything the department has started and not yet signed off.
 *
 * `state` narrows it: the bench works `accessioned` and `in_analysis`, the pathologist works
 * `resulted`. Passing nothing returns all three, which is what a small laboratory's one screen
 * shows.
 */
export async function labWorklist(
  db: Db,
  actor: Actor,
  states: readonly string[],
): Promise<WorklistRow[]> {
  if (actor.type !== "user") {
    throw new LabError("user_actor_required", `a ${actor.type} actor may not read a lab worklist`);
  }
  if (!(await hasPermission(db, actor.id, WORKLIST_READ, "hospital"))) {
    throw new LabError("permission_denied", `reading a lab worklist requires ${WORKLIST_READ}`);
  }
  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");

  const rows = await db
    .select({
      orderItemId: orderItems.id,
      orderId: orders.id,
      orderNo: orders.orderNo,
      encounterNo: orders.encounterNo,
      patientId: orders.patientId,
      patientName: patients.name,
      patientAlias: patients.alias,
      patientConfidential: patients.isConfidential,
      serviceId: orderItems.serviceId,
      orderableCode: labOrderables.code,
      orderableName: labOrderables.nameEn,
      discipline: labOrderables.discipline,
      priority: labItems.priority,
      state: workflowInstances.currentState,
      tatStartedAt: labItems.tatStartedAt,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(labItems, eq(labItems.orderItemId, orderItems.id))
    .innerJoin(labOrderables, eq(labOrderables.serviceId, orderItems.serviceId))
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .innerJoin(workflowInstances, eq(workflowInstances.id, labItems.instanceId))
    .where(and(
      /** THE ENVELOPE IS THE GATE — see the header. A cancelled item is nobody's work. */
      eq(orderItems.status, "in_progress"),
      inArray(workflowInstances.currentState, [...states]),
    ))
    .orderBy(asc(labItems.tatStartedAt));
  if (rows.length === 0) return [];

  const itemIds = rows.map((r) => r.orderItemId);
  const [tubes, results] = await Promise.all([
    db.select({ orderItemId: labSpecimenItems.orderItemId, specimenNo: labSpecimens.specimenNo })
      .from(labSpecimenItems)
      .innerJoin(labSpecimens, eq(labSpecimens.id, labSpecimenItems.specimenId))
      .where(and(inArray(labSpecimenItems.orderItemId, itemIds), eq(labSpecimenItems.active, true))),
    db.select().from(labResults).where(inArray(labResults.orderItemId, itemIds))
      .orderBy(asc(labResults.enteredAt)),
  ]);
  const tubeBy = new Map(tubes.map((t) => [t.orderItemId, t.specimenNo] as const));

  /** The analytes each orderable reports, in REPORT order — ONE query for the whole list. */
  const joins = await db
    .select({ serviceId: labOrderableAnalytes.serviceId, position: labOrderableAnalytes.position, analyte: labAnalytes })
    .from(labOrderableAnalytes)
    .innerJoin(labAnalytes, eq(labAnalytes.id, labOrderableAnalytes.analyteId))
    .where(inArray(labOrderableAnalytes.serviceId, [...new Set(rows.map((r) => r.serviceId))]))
    .orderBy(asc(labOrderableAnalytes.position));

  return rows.map((r) => ({
    orderItemId: r.orderItemId,
    orderId: r.orderId,
    orderNo: r.orderNo,
    encounterNo: r.encounterNo,
    patientId: r.patientId,
    patientDisplay: displayName(
      { name: r.patientName, alias: r.patientAlias, isConfidential: r.patientConfidential },
      canSeeConfidential,
    ),
    serviceId: r.serviceId,
    orderableCode: r.orderableCode,
    orderableName: r.orderableName,
    discipline: r.discipline,
    priority: r.priority,
    state: r.state,
    specimenNo: tubeBy.get(r.orderItemId) ?? null,
    tatStartedAt: r.tatStartedAt?.toISOString() ?? null,
    analytes: joins
      .filter((j) => j.serviceId === r.serviceId)
      .map((j) => {
        /** The LATEST row per analyte: a rerun writes a new one rather than editing the old. */
        const value = results.filter(
          (x) => x.orderItemId === r.orderItemId && x.analyteId === j.analyte.id,
        ).at(-1);
        return {
          analyteId: j.analyte.id,
          code: j.analyte.code,
          nameEn: j.analyte.nameEn,
          unit: j.analyte.unit,
          resultType: j.analyte.resultType,
          resultId: value?.id ?? null,
          value: value ? (value.valueNumeric ?? value.valueText ?? value.valueCoded ?? "") : null,
          flag: value?.flag ?? null,
          refLow: value?.refLow ?? null,
          refHigh: value?.refHigh ?? null,
          refText: value?.refText ?? null,
          verificationStatus: value?.verificationStatus ?? null,
          enteredById: value?.enteredById ?? null,
          pathologistReviewPending: value?.pathologistReviewPending ?? false,
        };
      }),
  }));
}

/** The bench: work received and being run. */
export async function benchWorklist(db: Db, actor: Actor): Promise<WorklistRow[]> {
  return labWorklist(db, actor, ["accessioned", "in_analysis"]);
}

/** The pathologist: numbers keyed and awaiting a signature (DD11's queue). */
export async function verifyWorklist(db: Db, actor: Actor): Promise<WorklistRow[]> {
  return labWorklist(db, actor, ["resulted"]);
}

export type PublishableOrder = {
  orderId: string;
  orderNo: string;
  encounterNo: string;
  patientId: string;
  patientDisplay: string;
  serviceDate: string;
  /** Every reportable item finished — a FULL report. False means only 02 D7's partial is available. */
  complete: boolean;
  itemCount: number;
  completedCount: number;
  orderables: string[];
};

/**
 * ═══ CLOSE REVIEW (web) C3 — THE ORDERS A REPORT CAN ACTUALLY BE PUBLISHED FOR ═══
 *
 * The verify screen's Publish button sat on a `verifyWorklist` row, and that row DISAPPEARS at the
 * moment publishing becomes legal: `verifyResult` advances the item to `completed` on the last
 * signature, `verifyWorklist` filters on `in_progress` + `resulted`, and `publishReport` refuses
 * anything not `completed`. **The two conditions were mutually exclusive, so no report could be
 * published from any screen in the system.**
 *
 * This is the reader that closes it: lab orders whose items have all reached a terminal state and
 * which carry no published report yet. `complete` distinguishes a full report from 02 D7's partial,
 * so the screen can offer the right one rather than guessing.
 */
export async function publishableOrders(db: Db, actor: Actor): Promise<PublishableOrder[]> {
  if (actor.type !== "user") {
    throw new LabError("user_actor_required", `a ${actor.type} actor may not read the publish queue`);
  }
  if (!(await hasPermission(db, actor.id, WORKLIST_READ, "hospital"))) {
    throw new LabError("permission_denied", `reading the publish queue requires ${WORKLIST_READ}`);
  }
  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");

  const rows = await db
    .select({
      orderId: orders.id, orderNo: orders.orderNo, encounterNo: orders.encounterNo,
      serviceDate: orders.serviceDate, patientId: orders.patientId,
      patientName: patients.name, patientAlias: patients.alias,
      patientConfidential: patients.isConfidential,
      itemStatus: orderItems.status, orderableCode: labOrderables.code,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(labItems, eq(labItems.orderItemId, orderItems.id))
    .innerJoin(labOrderables, eq(labOrderables.serviceId, orderItems.serviceId))
    .innerJoin(patients, eq(patients.id, orders.patientId))
    .where(eq(orders.kind, "lab"))
    .orderBy(asc(orders.placedAt));
  if (rows.length === 0) return [];

  /** Orders that already carry a published version are not offered — an amendment is a other act. */
  const published = new Set(
    (await db.select({ orderId: labReports.orderId }).from(labReports)
      .where(eq(labReports.status, "published"))).map((r) => r.orderId),
  );

  const byOrder = new Map<string, PublishableOrder & { reportable: number }>();
  for (const r of rows) {
    if (published.has(r.orderId)) continue;
    const entry = byOrder.get(r.orderId) ?? {
      orderId: r.orderId, orderNo: r.orderNo, encounterNo: r.encounterNo,
      patientId: r.patientId,
      patientDisplay: displayName(
        { name: r.patientName, alias: r.patientAlias, isConfidential: r.patientConfidential },
        canSeeConfidential,
      ),
      serviceDate: r.serviceDate, complete: true, itemCount: 0, completedCount: 0,
      orderables: [], reportable: 0,
    };
    entry.itemCount += 1;
    /** A CANCELLED item is not on the report and does not hold it back (`buildSnapshot`'s rule). */
    if (r.itemStatus !== "cancelled") {
      entry.reportable += 1;
      if (!entry.orderables.includes(r.orderableCode)) entry.orderables.push(r.orderableCode);
      if (r.itemStatus === "completed") entry.completedCount += 1;
    }
    byOrder.set(r.orderId, entry);
  }

  return [...byOrder.values()]
    /** At least one finished item, or there is nothing to report even partially. */
    .filter((o) => o.completedCount > 0)
    .map(({ reportable, ...o }) => ({ ...o, complete: o.completedCount === reportable }));
}
