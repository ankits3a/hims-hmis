import { and, asc, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { LIVE_ITEM_STATUSES } from "../../kernel/orders/transitions";
import {
  labAnalytes, labItems, labOrderableAnalytes, labOrderables, labReports, labResults,
  labSpecimenItems, labSpecimens, orderItems, orders, patients, workflowInstances,
} from "../../kernel/db/schema";
import { listMergedLoserIds } from "../patients";
import { canonicalNames } from "./criticals";
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
  /** 17c T4 — the orderable's target for THIS item's priority (`tat_minutes_stat` when STAT, else routine). */
  tatTargetMinutes: number;
  analytes: {
    analyteId: string; code: string; nameEn: string; unit: string | null; resultType: string;
    resultId: string | null; value: string | null; flag: string | null;
    refLow: string | null; refHigh: string | null; refText: string | null;
    verificationStatus: string | null; enteredById: string | null;
    pathologistReviewPending: boolean;
    /**
     * 17c T4 / D11 — the last VERIFIED value of this analyte on the canonical patient (the merge
     * chain, edge case 5), from any earlier item. Never an unverified or superseded row: a number
     * nobody signed is not a number a pathologist compares against.
     */
    previous: { resultId: string; value: string; flag: string | null; at: string } | null;
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
      tatRoutine: labOrderables.tatMinutesRoutine,
      tatStat: labOrderables.tatMinutesStat,
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

  /** THE CANONICAL PATIENT DECIDES THE ALIAS (pass 2, F8) — see `canonicalNames`' own header. */
  const canonical = await canonicalNames(db, rows.map((r) => r.patientId), canSeeConfidential);
  const previous = await previousVerified(
    db,
    [...new Set(rows.map((r) => canonical.get(r.patientId)?.id ?? r.patientId))],
    [...new Set(joins.map((j) => j.analyte.id))],
  );

  return rows.map((r) => ({
    orderItemId: r.orderItemId,
    orderId: r.orderId,
    orderNo: r.orderNo,
    encounterNo: r.encounterNo,
    patientId: canonical.get(r.patientId)?.id ?? r.patientId,
    patientDisplay: canonical.get(r.patientId)?.display ?? "—",
    serviceId: r.serviceId,
    orderableCode: r.orderableCode,
    orderableName: r.orderableName,
    discipline: r.discipline,
    priority: r.priority,
    state: r.state,
    specimenNo: tubeBy.get(r.orderItemId) ?? null,
    tatStartedAt: r.tatStartedAt?.toISOString() ?? null,
    tatTargetMinutes: r.priority === "stat" && r.tatStat !== null ? r.tatStat : r.tatRoutine,
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
          /**
           * The row's OWN item is excluded here, per row — not the whole worklist's items up in the
           * query. The first cut excluded every listed item, and the assertion book's mutant
           * (latest by `entered_at`, verified or not) SURVIVED it: yesterday's unverified TSH was on
           * the same queue and vanished by exclusion rather than by the verified filter.
           */
          previous: (previous.get(`${canonical.get(r.patientId)?.id ?? r.patientId}|${j.analyte.id}`) ?? [])
            .find((p) => p.orderItemId !== r.orderItemId) ?? null,
        };
      }),
  }));
}

type PreviousValue = { resultId: string; value: string; flag: string | null; at: string; orderItemId: string };

/**
 * D11 — for each (canonical patient, analyte): the VERIFIED results across the patient's merge
 * chain, newest first. One query for the whole worklist; the caller drops its own item.
 */
async function previousVerified(
  db: Db,
  canonicalIds: readonly string[],
  analyteIds: readonly string[],
): Promise<Map<string, PreviousValue[]>> {
  const out = new Map<string, PreviousValue[]>();
  if (canonicalIds.length === 0 || analyteIds.length === 0) return out;
  const canonicalOf = new Map<string, string>();
  for (const id of canonicalIds) {
    canonicalOf.set(id, id);
    for (const loser of await listMergedLoserIds(db, id)) canonicalOf.set(loser, id);
  }
  const rows = await db
    .select({
      id: labResults.id, analyteId: labResults.analyteId, patientId: orders.patientId, orderItemId: labResults.orderItemId,
      valueNumeric: labResults.valueNumeric, valueText: labResults.valueText, valueCoded: labResults.valueCoded,
      flag: labResults.flag, verifiedAt: labResults.verifiedAt,
    })
    .from(labResults)
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(
      inArray(labResults.analyteId, [...analyteIds]),
      eq(labResults.verificationStatus, "verified"),
      inArray(orders.patientId, [...canonicalOf.keys()]),
    ))
    .orderBy(desc(labResults.verifiedAt));
  for (const r of rows) {
    if (r.verifiedAt === null) continue;
    const key = `${canonicalOf.get(r.patientId) ?? r.patientId}|${r.analyteId}`;
    const list = out.get(key) ?? [];
    list.push({
      resultId: r.id, value: r.valueNumeric ?? r.valueText ?? r.valueCoded ?? "",
      flag: r.flag, at: r.verifiedAt.toISOString(), orderItemId: r.orderItemId,
    });
    out.set(key, list);
  }
  return out;
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
  /** Non-null when a PARTIAL version already stands — the screen AMENDS it (pass 2, F9). */
  amendsReportId: string | null;
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
/** A publish queue is a TODAY list. Older orders are reprints, reached from the patient's record. */
export const PUBLISH_QUEUE_DAYS = 7;

export async function publishableOrders(
  db: Db,
  actor: Actor,
  now: Date = new Date(),
): Promise<PublishableOrder[]> {
  if (actor.type !== "user") {
    throw new LabError("user_actor_required", `a ${actor.type} actor may not read the publish queue`);
  }
  if (!(await hasPermission(db, actor.id, WORKLIST_READ, "hospital"))) {
    throw new LabError("permission_denied", `reading the publish queue requires ${WORKLIST_READ}`);
  }
  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");

  /**
   * ═══ BOUNDED, AND IT OFFERS 02 D7's SECOND LEG — CLOSE REVIEW PASS 2, F9 ═══
   *
   * The first version had no status filter, no window and no limit: every lab order item ever
   * created, joined four ways, materialised in JS on a screen that refetches after every signature.
   * That is the class M6 was fixed for, reintroduced on the verify screen's hot path.
   *
   * And it excluded any order carrying a `published` report — so the moment a PARTIAL v1 existed
   * the order dropped out for ever and there was no screen path to publish the rest. Web C3's
   * defect ("no report could be published from any screen"), reproduced one version later. An order
   * whose current published version is PARTIAL stays on the queue, flagged, and the screen amends it.
   */
  const since = new Date(now.getTime() - PUBLISH_QUEUE_DAYS * 86_400_000);
  const rows = await db
    .select({
      orderId: orders.id, orderNo: orders.orderNo, encounterNo: orders.encounterNo,
      serviceDate: orders.serviceDate, patientId: orders.patientId,
      itemStatus: orderItems.status, orderableCode: labOrderables.code,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(labItems, eq(labItems.orderItemId, orderItems.id))
    .innerJoin(labOrderables, eq(labOrderables.serviceId, orderItems.serviceId))
    .where(and(
      eq(orders.kind, "lab"),
      /** A queue is a TODAY thing. An order older than the window is a reprint, not a publish. */
      gte(orders.placedAt, since),
      /** Nothing to publish while an item has not been picked up at all. */
      ne(orderItems.status, "placed"),
    ))
    .orderBy(asc(orders.placedAt));
  if (rows.length === 0) return [];

  /**
   * A COMPLETE published version closes the queue entry; a PARTIAL one does not. `version` picks
   * the current row when several exist, and only `published` counts — a `superseded` version is
   * history.
   */
  const publishedRows = await db
    .select({ orderId: labReports.orderId, partial: labReports.partial, id: labReports.id })
    .from(labReports)
    .where(and(
      eq(labReports.status, "published"),
      inArray(labReports.orderId, [...new Set(rows.map((r) => r.orderId))]),
    ));
  const publishedBy = new Map(publishedRows.map((r) => [r.orderId, r] as const));

  const canonical = await canonicalNames(db, rows.map((r) => r.patientId), canSeeConfidential);

  const byOrder = new Map<string, PublishableOrder & { reportable: number }>();
  for (const r of rows) {
    const already = publishedBy.get(r.orderId);
    if (already && !already.partial) continue;
    const entry = byOrder.get(r.orderId) ?? {
      orderId: r.orderId, orderNo: r.orderNo, encounterNo: r.encounterNo,
      patientId: canonical.get(r.patientId)?.id ?? r.patientId,
      patientDisplay: canonical.get(r.patientId)?.display ?? "—",
      /** Set when a PARTIAL version already stands: the screen AMENDS rather than publishes. */
      amendsReportId: already?.id ?? null,
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

/* ═══════════════════════════════════════════════════════════════════════════════════════════ */
/* PLAN 17c T3 / D7 — WHAT HAS ARRIVED AND IS NOT YET RECEIVED                                  */
/* ═══════════════════════════════════════════════════════════════════════════════════════════ */

export type BenchArrivalRow = {
  specimenId: string;
  specimenNo: string;
  orderGroupId: string;
  patientId: string;
  patientDisplay: string;
  encounterNo: string;
  container: string;
  specimenType: string;
  collectionSite: string;
  priority: string;
  /** Hidden for a restricted item unless the reader holds `orders.read.restricted` — `collectionQueue`'s rule. */
  orderableCodes: string[];
  itemIds: string[];
  collectedAt: string | null;
  /** DD10 / 02 A2 — false means the bench must name who re-checked identity before receiving. */
  wristbandScanned: boolean;
  waitingMinutes: number;
};

/**
 * THE BENCH'S FIRST COLUMN — tubes drawn and in transit, not yet received. `GET
 * /lab/collection/specimen/:no` carries no patient by design (17a F18: no actor, no alias, no
 * log), so a scan at the bench had nothing to show until the tube was received. This reader takes
 * the actor, applies the alias rule through `canonicalNames`, and hides a restricted item's code
 * exactly as the chair's queue does. Sorted STAT first, then longest in transit.
 */
export async function benchArrivals(db: Db, actor: Actor): Promise<BenchArrivalRow[]> {
  if (actor.type !== "user") {
    throw new LabError("user_actor_required", `a ${actor.type} actor may not read a lab worklist`);
  }
  if (!(await hasPermission(db, actor.id, WORKLIST_READ, "hospital"))) {
    throw new LabError("permission_denied", `reading a lab worklist requires ${WORKLIST_READ}`);
  }
  const canSeeConfidential = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
  const canSeeRestricted = await hasPermission(db, actor.id, "orders.read.restricted", "hospital");
  const specimens = await db
    .select()
    .from(labSpecimens)
    .where(inArray(labSpecimens.status, ["collected", "in_transit"]))
    .orderBy(asc(labSpecimens.collectedAt));
  if (specimens.length === 0) return [];
  const links = await db
    .select({ specimenId: labSpecimenItems.specimenId, orderItemId: labSpecimenItems.orderItemId })
    .from(labSpecimenItems)
    .where(and(inArray(labSpecimenItems.specimenId, specimens.map((s) => s.id)), eq(labSpecimenItems.active, true)));
  if (links.length === 0) return [];
  const items = await db
    .select({
      itemId: orderItems.id, status: orderItems.status, restricted: orderItems.restricted,
      encounterNo: orders.encounterNo, priority: labItems.priority, code: labOrderables.code,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(labItems, eq(labItems.orderItemId, orderItems.id))
    .innerJoin(labOrderables, eq(labOrderables.serviceId, orderItems.serviceId))
    /** LIVE, not `in_progress`: the envelope is `placed` until `receive` starts the clock (17a F-set's own lesson). */
    .where(and(inArray(orderItems.id, links.map((l) => l.orderItemId)), inArray(orderItems.status, [...LIVE_ITEM_STATUSES])));
  const byItem = new Map(items.map((i) => [i.itemId, i]));
  const names = await canonicalNames(db, [...new Set(specimens.map((s) => s.patientId))], canSeeConfidential);
  const rank: Record<string, number> = { stat: 0, urgent: 1, routine: 2 };
  const now = Date.now();
  const rows: BenchArrivalRow[] = [];
  for (const s of specimens) {
    const mine = links.filter((l) => l.specimenId === s.id).map((l) => byItem.get(l.orderItemId))
      .filter((i): i is NonNullable<typeof i> => i !== undefined);
    if (mine.length === 0) continue;
    rows.push({
      specimenId: s.id, specimenNo: s.specimenNo, orderGroupId: s.orderGroupId,
      patientId: names.get(s.patientId)?.id ?? s.patientId,
      patientDisplay: names.get(s.patientId)?.display ?? "—",
      encounterNo: mine[0]!.encounterNo,
      container: s.container, specimenType: s.specimenType, collectionSite: s.collectionSite,
      priority: mine.map((m) => m.priority).sort((a, b) => (rank[a] ?? 3) - (rank[b] ?? 3))[0]!,
      orderableCodes: mine.filter((m) => canSeeRestricted || !m.restricted).map((m) => m.code),
      itemIds: mine.map((m) => m.itemId),
      collectedAt: s.collectedAt?.toISOString() ?? null,
      wristbandScanned: s.wristbandScanned === true,
      waitingMinutes: s.collectedAt ? Math.max(0, Math.floor((now - s.collectedAt.getTime()) / 60_000)) : 0,
    });
  }
  return rows.sort((a, b) => (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3) || b.waitingMinutes - a.waitingMinutes);
}

