import { eq } from "drizzle-orm";
import { withIdempotency } from "../billing";
import { getEncounter } from "../opd";
import { daycareCaseDefinition } from "../ot";
import { daycareEncounters } from "../../kernel/db/schema/ot";
import { orders } from "../../kernel/db/schema/orders";
import { patients } from "../../kernel/db/schema/patients";
import { placeOrder } from "../../kernel/orders/place";
import { findRecentItems } from "../../kernel/orders/read";
import { withTx } from "../../kernel/db/client";
import { EPISODE_SERIES } from "../../kernel/episodes/series";
import { RadiologyError } from "./errors";
import { pcpndtApplicability } from "./applicability";
import { studyTypeByService as studyTypeByServiceOwned } from "./study-types";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { OrderItemOrigin } from "../../kernel/db/schema/orders";

/**
 * PLAN 18a T3 / DD9 + DD10 + DD14 — **PLACING AN IMAGING ORDER.**
 *
 * The composition the phase document specifies, in this order and for reasons that are not
 * interchangeable: `withIdempotency` → the encounter-status guard → the PCPNDT applicability rule
 * → the duplicate-window guard → `placeOrder`, all of the last four on ONE transaction.
 *
 * ═══ THE DUPLICATE GUARD RUNS LAST, AND THAT IS DELIBERATE ═══
 *
 * A refusal should name the most specific fault a caller can act on. An order on a closed encounter
 * and an order that duplicates yesterday's are both refusals, but "this visit is closed, open a new
 * one" is actionable and "you already ordered this" is confusing when the visit was never valid.
 *
 * ═══ THE STUDY TYPE IS RESOLVED FROM THE PUBLISHED BOOK, NEVER FROM THE CALLER ═══
 *
 * A caller does not say whether a scan falls under the PCPNDT Act — it says which SERVICE was
 * ordered, and this function looks the service up in the ACTIVE `study_types` definition (DD13).
 * That is the difference between a statutory control and a checkbox: an input carrying
 * `pcpndtApplicable: false` would be a bypass anybody with the route could type, and N2's
 * "no emergency bypass exists" would be a sentence in a document rather than a property of the code.
 *
 * The consequence is that **a hospital that has published no study-type book cannot place an
 * imaging order at all** (`definition_not_active`). That is the correct state: the book is where
 * the gate sets, the radiation flags and the PCPNDT applicability live, and a scan ordered before
 * it exists is a scan nothing can decide anything about.
 */

/** What one item of the order asks for. The study type is DERIVED from `serviceId`, never passed. */
export type PlaceImagingItemInput = {
  /** A `services.id`. The active `study_types` body maps it to exactly one study type. */
  serviceId: string;
  origin?: OrderItemOrigin;
  /** The add-on's parent item, which lives on ANOTHER order (DD10c / phase 0 E2). */
  parentItemId?: string | null;
  /** DD10b — passed TOGETHER with `duplicateReason` to override the 24-hour window. */
  duplicateOfItemId?: string | null;
  duplicateReason?: string | null;
};

type PlaceImagingOrderBase = {
  patientId: string;
  /** The EPISODE NUMBER — `V…` or `D…`. Resolved through the kernel's prefix registry. */
  encounterNo: string;
  /** The IST calendar day, resolved by the CALLER with `istDate` (the kernel seam's own rule). */
  serviceDate: string;
  orderGroupId?: string;
  priority?: "routine" | "urgent" | "stat";
  orderingClinicianId?: string | null;
  /**
   * REQUIRED in practice: `radiologyManifest` declares `requiresIndication: true`, so `placeOrder`
   * refuses an imaging order with no reason. Typed as optional here only because the kernel owns
   * that refusal and duplicating it would be two answers to one question.
   */
  indication?: string | null;
  placedAt?: Date;
  items: readonly PlaceImagingItemInput[];
};

export type PlaceImagingOrderInput = PlaceImagingOrderBase &
  (
    | { authority?: "clinician"; externalReferrerId?: null }
    | { authority: "external_prescription"; externalReferrerId: string }
  );

export type PlaceImagingOrderResult = {
  orderId: string;
  orderNo: string;
  itemIds: string[];
  /** Per item, in the SAME order as `items` — what the PCPNDT rule decided and why. */
  pcpndt: { serviceId: string; studyTypeCode: string; applicable: boolean; reason: string }[];
};

/** DD9's OPD statuses. `completed` is admitted separately, with an age test. */
const OPD_OPEN_STATUSES = ["registered", "waiting", "in_consultation", "awaiting_results"];
/** DD9 — the consultant who adds a scan after the patient has left the room. */
export const COMPLETED_VISIT_GRACE_DAYS = 7;
/** DD10b — the natural-key duplicate window. */
export const DUPLICATE_WINDOW_HOURS = 24;

/**
 * The day-care terminal statuses, taken from the OT's OWN exported workflow definition rather than
 * transcribed. `daycareCaseDefinition` is the one place that knows which states end a case; a copy
 * here would be a second answer that goes stale the first time the OT adds one.
 */
function terminalDaycareStatuses(): Set<string> {
  return new Set(
    daycareCaseDefinition.states.filter((state) => state.terminal === true).map((state) => state.name),
  );
}

/**
 * ═══ FINDING F13 IS CLOSED: `study-types.ts` OWNS THE BOOK, AND THIS FILE DELEGATES ═══
 *
 * T3 shipped its own `activeStudyTypes` / `studyTypeByService` here because T4 had not run and
 * placement needed `pcpndt_applicable`. F13 recorded the debt: *"T4 must make `study-types.ts` the
 * single owner and have this delegate, or the hospital will have two readers of one book."*
 *
 * T4 did. The two functions are RE-EXPORTED from their owner rather than reimplemented, so there is
 * exactly one piece of code that decides whether a scan falls under the PCPNDT Act. The re-export
 * keeps T3's callers and tests working unchanged, which is what makes closing the finding cheap
 * enough to actually do.
 */
export { activeStudyTypes, studyTypeByService } from "./study-types";
export type { StudyType } from "./definitions";

/**
 * DD9's encounter-status guard. Reads the encounter through its OWNING module's export for `V`
 * (`getEncounter`, which since Lane A's F1 repair accepts a visit NUMBER as well as a row id) and
 * the day-care row for `D`.
 */
async function assertEncounterOpen(tx: Tx, encounterNo: string, now: Date): Promise<void> {
  if (encounterNo.startsWith(EPISODE_SERIES.daycare)) {
    const rows = await (tx as unknown as Db)
      .select({ status: daycareEncounters.status })
      .from(daycareEncounters)
      .where(eq(daycareEncounters.encounterNo, encounterNo));
    const status = rows[0]?.status;
    if (status !== undefined && terminalDaycareStatuses().has(status)) {
      throw new RadiologyError(
        "encounter_closed",
        `day-care encounter ${encounterNo} is ${status} — a scan cannot hang off a case that has ended`,
        { encounterNo, status },
      );
    }
    return;
  }

  const encounter = await getEncounter(tx as unknown as Db, encounterNo);
  /**
   * A `V` number the OPD does not know is NOT this guard's refusal to make. `placeOrder` resolves
   * the encounter on the same transaction and answers `unknown_encounter`, which is the more
   * specific fault; refusing here would shadow it with a vaguer one.
   */
  if (!encounter) return;

  if (OPD_OPEN_STATUSES.includes(encounter.status)) return;

  if (encounter.status !== "completed") {
    /** `abandoned`, and anything a later phase adds that is not `completed`. */
    throw new RadiologyError(
      "encounter_closed",
      `visit ${encounterNo} is ${encounter.status} — open a new visit for this scan`,
      { encounterNo, status: encounter.status },
    );
  }

  /**
   * ═══ THE SEVEN-DAY GRACE, MEASURED FROM THE VISIT'S OWN SERVICE DATE ═══
   *
   * DD9 admits a `completed` visit "within 7 days" — the consultant who adds a scan after the
   * patient has left the room, which is the normal corporate case. The anchor is `service_date`,
   * the IST calendar day the visit belongs to, because that is the only completion instant this
   * table records; there is no `completed_at`. A2's mutant is dropping this test entirely, and the
   * consequence it names is a scan hanging off last month's visit with Plan 08's dues following it.
   */
  const serviceDay = new Date(`${encounter.serviceDate}T00:00:00.000Z`);
  const ageDays = Math.floor((now.getTime() - serviceDay.getTime()) / 86_400_000);
  if (ageDays > COMPLETED_VISIT_GRACE_DAYS) {
    throw new RadiologyError(
      "encounter_closed",
      `visit ${encounterNo} completed ${ageDays} days ago, beyond the ${COMPLETED_VISIT_GRACE_DAYS}-day ` +
        "grace — open a new visit for this scan",
      { encounterNo, status: encounter.status, ageDays },
    );
  }
}

export async function placeImagingOrder(
  db: Db,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: PlaceImagingOrderInput,
  idemKey?: string,
  now: Date = new Date(),
): Promise<PlaceImagingOrderResult> {
  /**
   * ═══ A1 — THE HOUSE IDEMPOTENCY MECHANISM, AND §6A.2 CLOSED ═══
   *
   * `(actorId, route, key)` unique, so a retried click replays the first response and mints
   * nothing. The mutant is dropping this: two `R` numbers, two studies and two slots for one
   * patient — phase 0 §6A.2's exact failure, and the reason it named the ROUTE as the owner of
   * idempotency rather than the kernel.
   */
  return await withIdempotency(
    db,
    { actorId: actor.id, route: "POST /radiology/orders", key: idemKey },
    input,
    async () =>
      await withTx(db, async (tx: Tx) => {
        if (input.items.length === 0) {
          throw new RadiologyError(
            "unknown_study_type",
            "an imaging order with no items asks the department to do nothing",
          );
        }

        /** (1) DD9 — the encounter must still be one a scan can hang off. */
        await assertEncounterOpen(tx, input.encounterNo, now);

        /** (2) DD14 — applicability per item, from the PUBLISHED book and the patient's record. */
        const byService = await studyTypeByServiceOwned(tx);
        const patientRows = await (tx as unknown as Db)
          .select({
            sex: patients.sex, dob: patients.dob, dobEstimated: patients.dobEstimated,
          })
          .from(patients)
          .where(eq(patients.id, input.patientId));
        const patient = patientRows[0];
        if (!patient) {
          throw new RadiologyError(
            "unknown_study",
            `no patient ${input.patientId}`,
            { patientId: input.patientId },
          );
        }

        const decided = input.items.map((item) => {
          const studyType = byService.get(item.serviceId);
          if (!studyType) {
            throw new RadiologyError(
              "unknown_study_type",
              `service ${item.serviceId} is not named by any study type in the active book — a ` +
                "scan whose type is unknown is a scan whose PCPNDT applicability is unknown",
              { serviceId: item.serviceId },
            );
          }
          const verdict = pcpndtApplicability(
            { sex: patient.sex, dob: patient.dob, dobEstimated: patient.dobEstimated },
            { pcpndtApplicable: studyType.pcpndt_applicable },
            /** The rule is evaluated on the day of the SCAN, which is this order's service date. */
            new Date(`${input.serviceDate}T00:00:00.000Z`),
          );
          return { item, studyType, verdict };
        });

        /**
         * (3) DD10b / A4 — THE 24-HOUR NATURAL-KEY GUARD.
         *
         * Same patient, same service, inside the window ⇒ refused, UNLESS the caller passes
         * `duplicateOfItemId` AND `duplicateReason`, in which case the item is placed with
         * `origin: 'duplicate_confirmed'`. I9's duplicate-charge rule falls out of this: two
         * doctors independently ordering the same CT are two charges and two doses, and the second
         * one has to be a decision somebody typed a reason for.
         */
        for (const { item } of decided) {
          if (item.duplicateOfItemId && item.duplicateReason) continue;
          const recent = await findRecentItems(
            tx, actor, input.patientId, item.serviceId, DUPLICATE_WINDOW_HOURS, now,
          );
          if (recent.length > 0) {
            throw new RadiologyError(
              "duplicate_recent",
              `service ${item.serviceId} was already ordered for this patient within ` +
                `${DUPLICATE_WINDOW_HOURS} hours (${recent.map((r) => r.orderNo).join(", ")}) — ` +
                "pass duplicateOfItemId and duplicateReason to order it again",
              { serviceId: item.serviceId, recentOrderNos: recent.map((r) => r.orderNo) },
            );
          }
        }

        const placeItems = decided.map(({ item, verdict }) => ({
          serviceId: item.serviceId,
          /** DD11 / DD14 — `restricted` is set by THIS module's own rule, exactly as phase 0 said. */
          restricted: verdict.applicable,
          origin:
            item.origin
            ?? (item.duplicateOfItemId && item.duplicateReason
              ? ("duplicate_confirmed" as OrderItemOrigin)
              : undefined),
          parentItemId: item.parentItemId ?? null,
          duplicateOfItemId: item.duplicateOfItemId ?? null,
          duplicateReason: item.duplicateReason ?? null,
        }));

        const common = {
          kind: "imaging",
          patientId: input.patientId,
          encounterNo: input.encounterNo,
          serviceDate: input.serviceDate,
          orderGroupId: input.orderGroupId,
          priority: input.priority ?? ("routine" as const),
          orderingClinicianId: input.orderingClinicianId,
          indication: input.indication,
          placedAt: input.placedAt,
          items: placeItems,
        };

        const placed =
          input.authority === "external_prescription"
            ? await placeOrder(tx, actor, decls, {
                ...common,
                authority: "external_prescription",
                externalReferrerId: input.externalReferrerId,
              })
            : await placeOrder(tx, actor, decls, common);

        return {
          orderId: placed.orderId,
          orderNo: placed.orderNo,
          itemIds: placed.itemIds,
          pcpndt: decided.map(({ item, studyType, verdict }) => ({
            serviceId: item.serviceId,
            studyTypeCode: studyType.code,
            applicable: verdict.applicable,
            reason: verdict.reason,
          })),
        };
      }),
  );
}

/**
 * ═══ DD10c / A5 — THE ADD-ON IS A NEW ORDER, NOT AN INSERT INTO THE PARENT ═══
 *
 * *"An add-on view is a NEW ORDER in the same `order_group_id` with `origin:'addon'` and
 * `parent_item_id` pointing across orders."* It costs one more `R` number per added view and buys
 * the absence of the one write phase 0 §6A.5/§6A.7 warned about: no insert into a live order's
 * items, no header lock, no deadlock against a concurrent close, **and no kernel edit** —
 * `addOrderItem` stays a function nobody owes anybody, which is the same ruling Lane A made for the
 * lab (its DD9).
 *
 * A5's census is the assertion that proves it: `grep -rn 'insert(orderItems)' apps/core/src/modules`
 * returns nothing, because the only writer of that table is the kernel's own `placeOrder`.
 */
export async function addImagingViews(
  db: Db,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  parentOrderId: string,
  input: Omit<PlaceImagingOrderInput, "orderGroupId">,
  idemKey?: string,
  now: Date = new Date(),
): Promise<PlaceImagingOrderResult> {
  const parentRows = await db
    .select({ groupId: orders.orderGroupId, patientId: orders.patientId })
    .from(orders)
    .where(eq(orders.id, parentOrderId));
  const parent = parentRows[0];
  if (!parent) {
    throw new RadiologyError("unknown_study", `no order ${parentOrderId}`, { parentOrderId });
  }

  return await placeImagingOrder(
    db,
    actor,
    decls,
    {
      ...input,
      /** THE ONE THING INHERITED FROM THE PARENT: the clinical act (phase 0 DD2). */
      orderGroupId: parent.groupId,
      items: input.items.map((item) => ({ ...item, origin: "addon" as OrderItemOrigin })),
    } as PlaceImagingOrderInput,
    idemKey,
    now,
  );
}
