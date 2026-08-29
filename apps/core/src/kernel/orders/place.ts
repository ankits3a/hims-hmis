import { newId } from "@hmis/contracts";
import { hasPermission } from "../auth/permissions";
import { orderItems, orders } from "../db/schema";
import { nextEpisodeNo } from "../episodes/series";
import { resolveEncounterByPrefix } from "../episodes/encounter-resolvers";
import { appendEvent } from "../events/append";
import { OrderError } from "./errors";
import { findOrderKindDecl } from "./kinds";
import { orderPlaced } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../db/client";
import type { OrderItemOrigin } from "../db/schema/orders";
import type { OrderKindDecl } from "./kinds";

/** The kernel's own placement permission. Held IN ADDITION to the kind's own (DD6). */
export const ORDERS_PLACE = "orders.place";

export type PlaceOrderItemInput = {
  /** A `services.id` — the same key `advised_tests` already carries. The ONLY tariff link (DD10). */
  serviceId: string;
  /** DD11 — set by the placing surface or by the claiming module's own rule (an HIV test code). */
  restricted?: boolean;
  origin?: OrderItemOrigin;
  /** The reflex trigger or the add-on's parent, which may live on ANOTHER order (E2). */
  parentItemId?: string | null;
  /** D11 — set TOGETHER with `duplicateReason` or not at all; the CHECK refuses a half. */
  duplicateOfItemId?: string | null;
  duplicateReason?: string | null;
};

type PlaceOrderBase = {
  kind: string;
  patientId: string;
  /** The EPISODE NUMBER (`V…`, `D…`), resolved through the prefix registry (DD8). */
  encounterNo: string;
  /**
   * The IST calendar day, RESOLVED BY THE CALLER with `istDate` and never derived here (S5, E14).
   * `istDate` lives in `modules/opd/time.ts`; a kernel seam that re-derived it would be a second
   * piece of code that might disagree about the offset, which `series.ts`'s header forbids.
   */
  serviceDate: string;
  /** Minted once per clinical act by the placing surface; defaults to this order's own (DD2). */
  orderGroupId?: string;
  priority?: "routine" | "urgent" | "stat";
  /** `users.id` — the RESPONSIBLE clinician, which may differ from whoever typed this (DD6). */
  orderingClinicianId?: string | null;
  /** Radiation justification and its kin; required when the kind declares `requiresIndication`. */
  indication?: string | null;
  /** A reflex rule id or standing-order id. Required for a `system` actor (DD6). */
  protocolRef?: string | null;
  /** The CLINICAL instant, which may precede `created_at` on a paper backfill (E13). */
  placedAt?: Date;
  items: readonly PlaceOrderItemInput[];
};

/**
 * ═══ `authority` IS DERIVED FROM THE ACTOR, EXCEPT WHERE IT IS A REAL CHOICE ═══
 *
 * DD6 maps four actor types onto four authorities, and three of those maps are total: a `patient`
 * is `self`, a `system` is `protocol`, an `agent` is nothing. Accepting `authority` as free input
 * would create a whole class of refusals — "patient actor claiming clinician authority" — that the
 * closed error union has no code for and that no caller could ever legitimately send.
 *
 * So the input carries an authority ONLY for the `user` leg, where it is a genuine clinical
 * distinction: a consultant's own order versus a walk-in arriving with an outside slip. And the two
 * are a DISCRIMINATED UNION, so `external_prescription` without a referrer does not compile —
 * 02 §1's commission ledger cannot attribute a walk-in it has no referrer for, and the CHECK that
 * would otherwise catch it reaches a counter as a constraint error rather than a sentence.
 */
export type PlaceOrderInput = PlaceOrderBase &
  (
    | { authority?: "clinician"; externalReferrerId?: null }
    | { authority: "external_prescription"; externalReferrerId: string }
  );

export type PlaceOrderResult = { orderId: string; orderNo: string; itemIds: string[] };

/**
 * PLAN 17 PHASE 0 T3 — PLACE AN ORDER.
 *
 * `(tx, actor, decls, input)` — the `createResource` shape, and `decls` is a REQUIRED parameter for
 * the reason that file's header gives at length: the write path must validate against the
 * declarations of the INSTALLED manifests, not against a module-level set assigned at boot (a
 * mutable global that makes every test either a boot or a lie) and not against a default that goes
 * stale without a typecheck error.
 *
 * **The plan document wrote the signature as `(tx, registry, decls, actor, input)` and the
 * `registry` is dropped here (finding F2).** `decls` IS `collectOrderKinds(registry)`, so carrying
 * both would be two hand-maintained copies of one fact in a single call — §2.54's mechanism at
 * argument scope — and a caller passing a registry and a `decls` array derived from a DIFFERENT one
 * would get silently wrong answers. Nothing in this function needs a registry: permissions are
 * asked of the database, not of the manifest list.
 *
 * ═══ EVERYTHING HAPPENS ON THE CALLER'S TRANSACTION ═══
 *
 * The counter mint, both inserts and the event append are one transaction, which is what makes A7
 * true: two concurrent placements contend on the `episode_series` row and get distinct numbers, and
 * a rolled-back placement leaves no order. The encounter is resolved on the same `tx` for the same
 * reason — reading it outside would let a visit be voided between the check and the insert.
 */
export async function placeOrder(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  const decl = findOrderKindDecl(decls, input.kind);
  if (!decl) {
    throw new OrderError(
      "unknown_kind",
      `no installed manifest claims the order kind "${input.kind}" — it is a legal string and not ` +
        "a kind this hospital has",
    );
  }
  if (input.items.length === 0) {
    throw new OrderError("no_items", "an order with no items asks a department to do nothing");
  }

  const authority = await resolveAuthority(tx, actor, decl, input);

  /**
   * THE CLINICAL AUTHORITY, checked AFTER the actor leg so a refusal names the more specific fault.
   * `ordering_clinician_id` may differ from `ordered_by_id` — a nurse keying a consultant's verbal
   * order is the normal case — and conflating them is how a nurse's account ends up as the ordering
   * physician on a CT.
   */
  if (decl.requiresClinician && !input.orderingClinicianId) {
    throw new OrderError(
      "clinician_required",
      `order kind "${decl.kind}" requires a responsible clinician, and none was named — the login ` +
        "that typed the order is not automatically the doctor answerable for it",
    );
  }
  if (decl.requiresIndication && !input.indication) {
    throw new OrderError(
      "indication_required",
      `order kind "${decl.kind}" requires a clinical indication (radiation justification and its kin)`,
    );
  }

  /**
   * THE ENCOUNTER, BY NUMBER, THROUGH THE PREFIX REGISTRY (DD8) — and the envelope deliberately
   * does NOT check its STATUS. Whether an order may follow a completed OPD visit or a discharged
   * day-care is the claiming module's guard; the envelope refuses only an encounter nobody owns.
   *
   * There is no fallback to OPD's reader here, unlike billing's wrapper: `encounter_no` is an
   * episode NUMBER and a bare `opd_encounters` row id is not one.
   */
  const encounter = await resolveEncounterByPrefix(tx, input.encounterNo);
  if (!encounter.matched || !encounter.resolved) {
    throw new OrderError(
      "unknown_encounter",
      `no registered prefix resolves encounter "${input.encounterNo}"`,
    );
  }
  /**
   * E19 / 02 A1 — THE ENCOUNTER'S PATIENT AND THE CALLER'S PATIENT MUST BE THE SAME PERSON. Without
   * this an order placed against the wrong visit produces a tube labelled for one patient and
   * reported under another, and every downstream read agrees with the wrong one.
   */
  if (encounter.resolved.patientId !== input.patientId) {
    throw new OrderError(
      "patient_encounter_mismatch",
      `encounter "${input.encounterNo}" belongs to a different patient than the one named`,
      { encounterPatientId: encounter.resolved.patientId, inputPatientId: input.patientId },
    );
  }

  /**
   * DD7 — the number comes from the EXISTING counter, on the kind's declared series and the
   * CALLER's service date. This phase adds no counter. `nextEpisodeNo`'s single-winner
   * `UPDATE … RETURNING` is what makes two concurrent placements distinct (A7).
   */
  const orderNo = await nextEpisodeNo(tx, decl.seriesKey, input.serviceDate);

  const orderId = newId();
  const placedAt = input.placedAt ?? new Date();
  await tx.insert(orders).values({
    id: orderId,
    orderNo,
    orderGroupId: input.orderGroupId ?? orderId,
    kind: decl.kind,
    patientId: input.patientId,
    encounterNo: input.encounterNo,
    serviceDate: input.serviceDate,
    priority: input.priority ?? "routine",
    authority,
    orderedByType: actor.type,
    orderedById: actor.id,
    orderingClinicianId: input.orderingClinicianId ?? null,
    /**
     * THE TWO COUPLED COLUMNS ARE WRITTEN ONLY WHEN THE **RESOLVED** AUTHORITY ADMITS THEM, and
     * that is a guard against our own CHECKs rather than a duplicate of them. `authority` is
     * derived from the ACTOR, so a caller could legitimately hand a `protocolRef` alongside a
     * `user` actor (a nurse keying a standing order by hand) — and passing it through would hit
     * `orders_protocol_ref_ck` and surface at a counter as a raw constraint error rather than as a
     * sentence. The envelope drops the field the authority does not admit; the CHECK stays as the
     * net for anything that reaches the table another way.
     */
    externalReferrerId: authority === "external_prescription" ? (input.externalReferrerId ?? null) : null,
    protocolRef: authority === "protocol" ? (input.protocolRef ?? null) : null,
    indication: input.indication ?? null,
    placedAt,
  });

  const itemIds: string[] = [];
  for (const item of input.items) {
    const itemId = newId();
    itemIds.push(itemId);
    await tx.insert(orderItems).values({
      id: itemId,
      orderId,
      serviceId: item.serviceId,
      origin: item.origin ?? "direct",
      restricted: item.restricted ?? false,
      parentItemId: item.parentItemId ?? null,
      duplicateOfItemId: item.duplicateOfItemId ?? null,
      duplicateReason: item.duplicateReason ?? null,
    });
  }

  await appendEvent(tx, orderPlaced.make({
    payload: {
      orderId, orderNo, kind: decl.kind, patientId: input.patientId,
      encounterNo: input.encounterNo, groupId: input.orderGroupId ?? orderId, itemIds,
    },
    actor,
    patientId: input.patientId,
    encounterId: input.encounterNo,
    correlationId: orderId,
    occurredAt: placedAt,
  }));

  return { orderId, orderNo, itemIds };
}

/**
 * ═══ DD6 — WHO MAY PLACE, DECIDED PER ACTOR TYPE, AND EVERY TYPE NAMED POSITIVELY ═══
 *
 * The shape is `workflow/instances.ts`'s post-22c-A shape and its reasoning is transcribed: an
 * `if user … else if agent …` chain over a union is not an exhaustiveness check, and when `patient`
 * joined the union that chain's silent fall-through was the TRUSTED branch. So this is a `switch`
 * over `actor.type` with no `default` — a fifth member stops compiling here rather than arriving
 * with whatever the last branch happened to be.
 */
async function resolveAuthority(
  tx: Tx,
  actor: Actor,
  decl: OrderKindDecl,
  input: PlaceOrderInput,
): Promise<"clinician" | "external_prescription" | "self" | "protocol"> {
  switch (actor.type) {
    /**
     * COPILOT DESIGN LAW: THE LLM NARRATES AND NEVER ORIGINATES. A drafter that proposes an
     * investigation produces an `advised_tests`-class SUGGESTION for a human to place (E12). This
     * is first because it is the refusal that must never acquire an exception.
     */
    case "agent":
      throw new OrderError(
        "agent_cannot_order",
        "an agent actor may not place an order — a drafter proposes, a human orders",
      );

    /**
     * A PATIENT, AND **NO PERMISSION LOOKUP IS EVER PERFORMED ON A PATIENT ID** (22c-A review D11).
     * `hasPermission` takes a `users.id`; handed a patient credential id it returns false, and
     * false ALIASES — "this patient may not" and "this user does not hold the permission" become
     * the same answer, so the refusal reason would be wrong and a later change to either path could
     * silently make it right for the wrong reason. The kind's own declaration is the whole gate.
     */
    case "patient":
      if (!decl.selfOrderable) {
        throw new OrderError(
          "self_order_not_permitted",
          `order kind "${decl.kind}" is not self-orderable — a patient may not place it`,
        );
      }
      return "self";

    /**
     * A REFLEX RULE OR A STANDING ORDER (E4, 02 D6), and it must be able to name itself. An
     * anonymous automated order is one nobody can withdraw, audit or explain to a patient.
     */
    case "system":
      if (!input.protocolRef) {
        throw new OrderError(
          "protocol_ref_required",
          "a system actor may place only under a protocol, and none was named — an automated " +
            "order that cannot name its rule is an order nobody can withdraw",
        );
      }
      return "protocol";

    /**
     * A STAFF USER NEEDS **BOTH** PERMISSIONS (A5): the kernel's `orders.place` and the kind's own.
     * Holding the kernel permission is what makes someone an order-placing member of staff at all;
     * the kind's permission is what makes them one for THIS department. Checking only the kernel
     * one lets a pharmacist place imaging.
     */
    case "user": {
      const exec = tx as unknown as Db;
      const holdsKernel = await hasPermission(exec, actor.id, ORDERS_PLACE, "hospital");
      const holdsKind = await hasPermission(exec, actor.id, decl.placePermission, "hospital");
      if (!holdsKernel || !holdsKind) {
        throw new OrderError(
          "permission_denied",
          `placing a "${decl.kind}" order requires both ${ORDERS_PLACE} and ${decl.placePermission}`,
          { holdsKernel, holdsKind },
        );
      }
      return input.authority ?? "clinician";
    }
  }
}
