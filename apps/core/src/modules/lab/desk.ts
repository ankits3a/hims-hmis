import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import {
  counterparties, invoiceLines, labItems, labOrderables, labSpecimens, opdDepartments, opdDoctors,
  opdEncounters, opdQueueEntries, orderItems, orders, patients,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { placeOrder } from "../../kernel/orders/place";
import { startInstance } from "../../kernel/workflow/instances";
import { issueInvoice } from "../billing";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { getEncounter, openLabWalkinInTx } from "../opd";
import { getPatientSummaries, listMergedLoserIds, resolvePatientId, searchPatients } from "../patients";
import { duplicateWarnings } from "./duplicates";
import { LabError } from "./errors";
import { labAttributionUnverifiedFlagged, labOrderDesked } from "./events";
import { LAB_ITEM_DEF_KEY } from "./workflow-def";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { OrderItemOrigin } from "../../kernel/db/schema/orders";
import type { PlaceOrderItemInput } from "../../kernel/orders/place";
import type { IssueInvoiceInput } from "../billing";
import type { AdvisedTest, EncounterRow } from "../opd";
import type { DuplicateWarning } from "./duplicates";

/**
 * PLAN 17a T4 / DD6 — THE DESK: what a doctor advised becomes an order AND an invoice, in ONE
 * transaction.
 *
 * ═══ THE SEAM, AND WHY IT LOOKS LIKE A LIE UNTIL YOU READ F7 ═══
 *
 * `issueInvoice(db: Db, …)` opens its OWN `withTx` (Plan 17 §9.3 S1), so the call below reads
 * `issueInvoice(tx as unknown as Db, …)` — a cast that appears to escape the caller's transaction
 * and does the opposite. drizzle's `transaction()` on a `Tx` opens a **SAVEPOINT**, and Plan 17a
 * §9.3 probed it against Postgres in both directions before a line of this file was written:
 * an inner commit followed by an OUTER throw leaves **zero rows**, and an inner throw leaves the
 * outer transaction alive. The cast is the shipped house pattern (`place.ts:296`,
 * `patients/registration.ts:408`, `materials/grn.ts:379`) and T4 A3 asserts it over this real pair
 * rather than over the probe.
 *
 * **What that buys is the whole of DD6.** A counter that placed the order and then billed would,
 * on any failure between the two, produce a test the lab will run and nobody will ever pay for —
 * or an invoice for a test nobody ordered. There is no compensating write that fixes either after
 * the fact, because the second half of the pair is a physical act by a phlebotomist.
 *
 * ═══ COLLECTION IS NEVER BLOCKED BY PAYMENT, AND THAT IS ALSO DD6 ═══
 *
 * The money is posted HERE, at order time. It is not a GATE here: `credit` lets the invoice carry a
 * remainder and the tube is still drawn. The interlock DD6 does impose is at the REPORT (17b T7),
 * where withholding costs a patient a delay rather than a specimen — a lab that refuses to draw
 * blood until the bill clears turns a cashier's queue into a clinical one.
 *
 * ═══ NO ROUTE, AND THEREFORE `withIdempotency` IS NOT CALLED HERE (DD22) ═══
 *
 * Phase 0 §6A.2 puts idempotency on the ROUTE. 17a mounts none, so this is a transaction-shaped
 * service and its A1/A1b/A2 rows call `withIdempotency` — imported from `../billing`, the same
 * function 17b's controller will wrap this in — around it in the test. Wrapping it INSIDE would put
 * the claim inside the transaction it is meant to arbitrate, which is the one shape that cannot
 * work: a rolled-back claim protects nothing.
 */

/** The desk's own gate. `placeOrder` separately requires `orders.place` AND `lab.orders.place`. */
export const LAB_DESK_OPERATE = "lab.desk.operate";

export type LabPriority = "routine" | "urgent" | "stat";
export type LabCollectionSite = "opd" | "ward" | "home" | "camp" | "external";

export type DeskItemInput = {
  /** A `services.id`, which IS the orderable's identity (DD1) — the key `advised_tests` carries. */
  serviceId: string;
  priority?: LabPriority;
  /** DD14 — required for a `consent_required` orderable, and refused BEFORE any write without it. */
  consent?: { recordedBy: string };
  collectionSite?: LabCollectionSite;
};

type DeskOrderBase = {
  patientId: string;
  /** The `V` number. Resolved through the prefix registry by `placeOrder`, never re-derived here. */
  encounterNo: string;
  /** The IST calendar day, resolved by the CALLER with `istDate` (E47) and never derived here. */
  serviceDate: string;
  /** The doctor answerable for the tests — on a walk-in, the pathologist of record (DD15). */
  orderingClinicianId: string;
  orderGroupId?: string;
  priority?: LabPriority;
  items: readonly DeskItemInput[];
  /** DD8 — order-time consent for reflex. `matchReflex` fires only where the item carries it. */
  reflexConsent?: boolean;
  /**
   * The `duplicateOfItemId` values the counter SHOWED and the clerk accepted. Anything the detector
   * finds and this list does not name refuses the whole order (`duplicate_unacknowledged`).
   */
  acknowledgedDuplicates?: readonly string[];
  chargeReason?: "lab_desk" | "lab_walkin" | "lab_addon";
  /** DD9 — `addOnOrder` passes `"addon"`. A confirmed duplicate overrides it: it carries a pointer. */
  itemOrigin?: OrderItemOrigin;
  draftId?: string;
  receipt?: IssueInvoiceInput["receipt"];
  credit?: { reason: string; approvalId?: string };
  tags?: string[];
  placedAt?: Date;
};

/**
 * The same DISCRIMINATED UNION `PlaceOrderInput` uses, and for the same reason: 02 §1's commission
 * ledger cannot attribute a walk-in it has no referrer for, and `orders_external_referrer_ck` is a
 * BICONDITIONAL — an `external_referrer_id` on a `clinician` order is refused too. Expressing it in
 * the type means the counter never meets that CHECK as a constraint error (S3: the column has no
 * foreign key, so the CHECK is the only thing standing there).
 */
export type DeskOrderInput = DeskOrderBase &
  (
    | { authority?: "clinician"; externalReferrerId?: null; referrerName?: null; attributionConfirmed?: boolean }
    | {
        authority: "external_prescription";
        /** A `counterparties.id`. ABSENT resolves to the sentinel (A7) — never left null. */
        externalReferrerId?: string | null;
        referrerName?: string | null;
        /** DD15 — an Rx image or a phone confirmation. Absent ⇒ `lab.attribution_unverified_flagged`. */
        attributionConfirmed?: boolean;
      }
  );

export type DeskOrderResult = {
  encounterNo: string;
  orderId: string;
  orderNo: string;
  orderGroupId: string;
  itemIds: string[];
  invoice: {
    draftId: string;
    invoiceId: string;
    invoiceNo: string;
    netPayablePaise: number;
    receiptId: string | null;
    receiptNo: string | null;
    creditExtended: boolean;
  };
  reflexConsent: boolean;
  duplicates: { acknowledged: string[]; warnings: DuplicateWarning[] };
};

async function assertMayDesk(exec: Db | Tx, actor: Actor): Promise<void> {
  /**
   * A `user` ACTOR ONLY, by TYPE before permission — `hasPermission` takes a `users.id`, and handed
   * a system or patient id it returns FALSE, which would report "this user lacks the permission"
   * about something that is not a user (22c-A review D11's aliasing argument). The desk is a
   * counter with a person behind it; there is no automated desking.
   */
  /**
   * ═══ `permission_denied`, NOT `unknown_service` — 17b T6 repairing 17a §9.2 F28 ═══
   *
   * A clerk without `lab.desk.operate` was told 404 *"no such service"*, indistinguishable at the
   * wire from a real orphan `serviceId` (A5's refusal) — so a counter meeting it would go hunting
   * the catalogue for a row that was never missing. The union carried no authorization code when T4
   * was written; 17b's §0 instructs the repair and the code exists now.
   */
  if (actor.type !== "user") {
    throw new LabError("permission_denied", `a ${actor.type} actor may not order at the lab desk`);
  }
  if (!(await hasPermission(exec as Db, actor.id, LAB_DESK_OPERATE, "hospital"))) {
    throw new LabError("permission_denied", `ordering at the lab desk requires ${LAB_DESK_OPERATE}`);
  }
}

/**
 * THE CONVERTER (A5). `advised_tests` is a SNAPSHOT the consult wrote — code, name and the price of
 * that afternoon — and only its `serviceId` survives into an order, because everything else is a
 * quotation rather than a fact (`consultation.ts`'s own header).
 *
 * It is a named export rather than an inline `.map` so that "converts EXACTLY" is a claim a test
 * can make about one function: the SET and the COUNT both, since a converter that silently deduped
 * would bill a patient for one of the two glucose tests a doctor deliberately advised twice.
 */
export function advisedTestItems(
  advised: readonly { serviceId: string }[],
): DeskItemInput[] {
  return advised.map((a) => ({ serviceId: a.serviceId }));
}

/**
 * THE SENTINEL COUNTERPARTY — 02 I3's "unattributed" bucket, as a row.
 *
 * `payee_class: 'external_rmp'` is class (c) of 02 D9, and `counterparties_id_payee_class_ux` is
 * what lets a ledger row point at the PAIR — so a commission accrual against this id is refused by
 * `accrual.ts` on the class, not on a name. Created on first use rather than by a seed script,
 * because a desk that refuses the first walk-in until somebody runs a script is a desk that gets
 * bypassed on paper. `onConflictDoNothing` on the unique CODE makes concurrent first-uses safe.
 */
export const EXTERNAL_UNATTRIBUTED_CODE = "EXTERNAL-UNATTRIBUTED";

async function ensureUnattributedReferrer(tx: Tx, actor: Actor): Promise<string> {
  const existing = (await tx
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(eq(counterparties.code, EXTERNAL_UNATTRIBUTED_CODE)))[0];
  if (existing) return existing.id;
  const id = newId();
  await tx.insert(counterparties).values({
    id, code: EXTERNAL_UNATTRIBUTED_CODE, name: "External referrer (unattributed)",
    payeeClass: "external_rmp", status: "active", createdBy: actor.id,
  }).onConflictDoNothing({ target: counterparties.code });
  const row = (await tx
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(eq(counterparties.code, EXTERNAL_UNATTRIBUTED_CODE)))[0];
  return row!.id;
}

/**
 * PLACE AND BILL, on the CALLER'S transaction. Everything below is one atom (A3).
 *
 * `decls` is a REQUIRED parameter and not a registry, which is `placeOrder`'s own ruling repeated
 * one layer out: carrying both would be two hand-maintained copies of one fact in a single call.
 */
export async function deskOrder(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: DeskOrderInput,
  now: Date = new Date(),
): Promise<DeskOrderResult> {
  await assertMayDesk(tx, actor);
  if (input.items.length === 0) {
    throw new LabError("unknown_service", "a lab order with no tests asks the lab to do nothing");
  }

  /**
   * (1) EVERY SERVICE ID IS AN ORDERABLE THIS HOSPITAL HAS, AND AN ORPHAN IS NAMED (A5).
   *
   * `advised_tests` carries a `serviceId` the consult snapshotted; between that afternoon and this
   * counter the catalogue can have been re-curated. Skipping the unknown one silently is the defect
   * this refusal exists for — the patient is then billed for two of three tests "as advised", and
   * the third is missing from a report nobody knows is incomplete.
   */
  const serviceIds = input.items.map((i) => i.serviceId);
  const orderables = await tx
    .select()
    .from(labOrderables)
    .where(inArray(labOrderables.serviceId, [...new Set(serviceIds)]));
  const byService = new Map(orderables.map((o) => [o.serviceId, o]));
  const orphans = [...new Set(serviceIds)].filter((s) => !byService.has(s));
  if (orphans.length > 0) {
    throw new LabError(
      "unknown_service",
      `no lab orderable for ${orphans.join(", ")} — the advised test is not in this hospital's ` +
        "catalogue, and placing the rest would bill the patient for part of what the doctor advised",
    );
  }
  const inactive = [...byService.values()].filter((o) => !o.active).map((o) => o.code);
  if (inactive.length > 0) {
    throw new LabError("unknown_service", `orderable(s) withdrawn from the catalogue: ${inactive.join(", ")}`);
  }

  /**
   * (1b) A GROUP BELONGS TO ONE PATIENT — close review pass 1, MAJOR 5, closed at BOTH ends.
   *
   * `orderGroupId` is free caller input and `placeOrder` writes it verbatim, so nothing but this
   * stops a second patient's tests joining an existing clinical act. `printLabels` refuses such a
   * group too, but refusing it HERE is what keeps the bad row out of the database rather than
   * merely un-labellable.
   */
  if (input.orderGroupId !== undefined) {
    /**
     * ═══ SERIALISED, AND COMPARED ON THE CANONICAL PATIENT — close review pass 2, findings 4 & 6 ═══
     *
     * Two corrections to the first remediation, and the first is the dangerous one.
     *
     * **The merge chain.** `patients/merge.ts` moves allergies and guardians and does NOT repoint
     * `orders.patient_id` — so one PERSON legitimately has orders under two ids, which is precisely
     * why `duplicates.ts` resolves the chain before it looks. Comparing raw ids made a merged
     * patient's own add-on look like a second person, and `printLabels` then refused the whole
     * group for ever with the money already taken. A safety guard that fails closed on the
     * legitimate act is worse than the hole it closes.
     *
     * **The race.** A bare `SELECT` under READ COMMITTED lets two calls carrying the same NEW group
     * id both read zero rows and both place — which is exactly the "the clerk's screen still holds
     * the group id" case this guard is for. The advisory lock is the house pattern
     * (`kernel/ops/mode.ts`, `users-admin.controller.ts`), taken first and released at commit, so it
     * introduces no new lock ordering.
     */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.orderGroupId}))`);
    const canonical = (await resolvePatientId(tx, input.patientId)) ?? input.patientId;
    const existing = await tx
      .select({ patientId: orders.patientId })
      .from(orders)
      .where(eq(orders.orderGroupId, input.orderGroupId));
    const foreign: { patientId: string }[] = [];
    for (const row of existing) {
      const rowCanonical = (await resolvePatientId(tx, row.patientId)) ?? row.patientId;
      if (rowCanonical !== canonical) foreign.push(row);
    }
    if (foreign.length > 0) {
      throw new LabError(
        "unknown_service",
        `order group ${input.orderGroupId} already belongs to a different patient — a clinical act ` +
          "is one person's, and joining another's would put two people's tests on one tube",
      );
    }
  }

  /**
   * (2) THE CONSENT GATE, **BEFORE `placeOrder`** (A4/DD14). An HIV test keyed without the counter
   * having taken written consent is not a data problem to fix later: the tube gets drawn.
   */
  for (const item of input.items) {
    const orderable = byService.get(item.serviceId)!;
    if (orderable.consentRequired && !item.consent) {
      throw new LabError(
        "consent_required",
        `${orderable.code} (${orderable.nameEn}) requires recorded consent before it may be ordered`,
      );
    }
  }

  /**
   * (3) DUPLICATES — the detector runs on THIS transaction, and anything it finds that the clerk
   * did not acknowledge refuses the order whole (DD1/E30). Partial placement is not on offer:
   * "place the two you did not query and drop the third" is a basket the counter never saw.
   */
  const acknowledged = [...(input.acknowledgedDuplicates ?? [])];
  const warnings = await duplicateWarnings(tx, actor, input.patientId, serviceIds, now);
  const unacknowledged = warnings.filter((w) => !acknowledged.includes(w.duplicateOfItemId));
  if (unacknowledged.length > 0) {
    throw new LabError(
      "duplicate_unacknowledged",
      unacknowledged.map((w) => w.reason).join("; "),
    );
  }
  /** First warning per requested service, so one item points at one prior item (the CHECK's pair). */
  const warningFor = new Map<string, DuplicateWarning>();
  for (const w of warnings) if (!warningFor.has(w.serviceId)) warningFor.set(w.serviceId, w);

  /**
   * (4) PLACEMENT. `restricted` is `consent_required` OR `sensitive` — DD14 and DD11 read together.
   * The fixture has five orderables that are sensitive WITHOUT needing consent (HBsAg, HCV, VDRL,
   * βhCG, UPT); a pregnancy test needs no signature and is still not for the ward clerk's screen,
   * and it is the kernel READER that acts on this boolean, so one false here is the whole of DD14
   * undone by a default.
   */
  const placeItems: PlaceOrderItemInput[] = input.items.map((item) => {
    const orderable = byService.get(item.serviceId)!;
    const dup = warningFor.get(item.serviceId);
    return {
      serviceId: item.serviceId,
      restricted: orderable.consentRequired || orderable.sensitive,
      /** The PAIR the CHECK demands: an id with no reason names nothing a reviewer can read. */
      ...(dup
        ? { origin: "duplicate_confirmed" as const, duplicateOfItemId: dup.duplicateOfItemId, duplicateReason: dup.reason }
        : { origin: input.itemOrigin ?? ("direct" as const) }),
    };
  });

  /**
   * (4a) DD15 / S3 — THE REFERRER COLUMN IS NEVER NULL ON A WALK-IN, AND THE SENTINEL IS WHY.
   *
   * `orders_external_referrer_ck` is a BICONDITIONAL and `orders.external_referrer_id` has NO
   * foreign key (S3), so the CHECK is the only thing standing there: an `external_prescription`
   * order without a referrer does not fail validation, it fails as a raw constraint error at a
   * counter. A walk-in whose referring doctor nobody could identify is the ordinary case — the slip
   * is a photocopy, the stamp is illegible — and refusing it would make the desk unusable for
   * exactly the patients DD15 exists for. **So an unnamed referrer becomes the sentinel, and the
   * order is FLAGGED rather than refused** (step 7). 02 D9's ledger accrues nothing to it either
   * way: `accrual.ts:319` refuses a payable to an `external_rmp` outright.
   */
  const externalReferrerId =
    input.authority === "external_prescription"
      ? (input.externalReferrerId ?? (await ensureUnattributedReferrer(tx, actor)))
      : null;

  const placed =
    input.authority === "external_prescription"
      ? await placeOrder(tx, actor, decls, {
          kind: "lab", patientId: input.patientId, encounterNo: input.encounterNo,
          serviceDate: input.serviceDate, orderGroupId: input.orderGroupId,
          priority: input.priority ?? "routine", orderingClinicianId: input.orderingClinicianId,
          placedAt: input.placedAt, items: placeItems,
          authority: "external_prescription", externalReferrerId: externalReferrerId!,
        })
      : await placeOrder(tx, actor, decls, {
          kind: "lab", patientId: input.patientId, encounterNo: input.encounterNo,
          serviceDate: input.serviceDate, orderGroupId: input.orderGroupId,
          priority: input.priority ?? "routine", orderingClinicianId: input.orderingClinicianId,
          placedAt: input.placedAt, items: placeItems,
        });
  const orderGroupId = input.orderGroupId ?? placed.orderId;

  /**
   * (5) THE MONEY, ON THE SAME TRANSACTION (A3). One line per ITEM, in input order — `lineNo` is
   * `index + 1` over exactly this array (`priceInvoiceLines` maps, it does not reorder), which is
   * what makes the read-back below positional rather than a guess.
   */
  const draftId = input.draftId ?? newId();
  const chargeReason = input.chargeReason ?? "lab_desk";
  const invoiceResult = await issueInvoice(
    tx as unknown as Db,
    actor,
    {
      draftId,
      patientId: input.patientId,
      encounterId: input.encounterNo,
      lines: input.items.map((item) => ({ lineId: newId(), serviceId: item.serviceId, qty: 1 })),
      tags: input.tags,
      receipt: input.receipt,
      credit: input.credit,
    },
    now,
  );

  /**
   * `invoice_lines.id` is minted INSIDE `issueInvoice` (`newId()`), not taken from the caller's
   * `lineId`, so the line each item was billed on is READ BACK rather than remembered. Ordered by
   * `lineNo`, which the map above pins to the item order; the length check is what makes that pin
   * an assertion instead of an assumption.
   */
  const billedLines = await tx
    .select({ id: invoiceLines.id, lineNo: invoiceLines.lineNo })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceResult.invoiceId))
    .orderBy(asc(invoiceLines.lineNo));
  if (billedLines.length !== input.items.length) {
    throw new LabError(
      "unknown_service",
      `the invoice carries ${billedLines.length} lines for ${input.items.length} tests — the desk ` +
        "cannot say which test each line paid for, and a lab item with the wrong invoice line is a " +
        "report released against somebody else's payment",
    );
  }

  /**
   * (6) THE LAB'S OWN ROWS, and one `lab_item` workflow instance each. `startInstance` throws
   * `no_active_definition` when the definitions have not been activated — the honest failure for a
   * hospital that has not adopted the lab's state machine (see `definitions.ts`).
   */
  const reflexConsentedAt = input.reflexConsent === true ? now : null;
  for (const [index, itemId] of placed.itemIds.entries()) {
    const item = input.items[index]!;
    const { instanceId } = await startInstance(tx, LAB_ITEM_DEF_KEY, {
      type: "lab_item", id: itemId, patientId: input.patientId, encounterId: input.encounterNo,
    });
    await tx.insert(labItems).values({
      orderItemId: itemId,
      instanceId,
      serviceId: item.serviceId,
      invoiceId: invoiceResult.invoiceId,
      invoiceLineId: billedLines[index]!.id,
      chargeReason,
      consentRecordedAt: item.consent ? now : null,
      consentRecordedBy: item.consent?.recordedBy ?? null,
      reflexConsentedAt,
      priority: item.priority ?? input.priority ?? "routine",
      collectionSite: item.collectionSite ?? "opd",
    });
  }

  await appendEvent(tx, labOrderDesked.make({
    actor,
    patientId: input.patientId,
    encounterId: input.encounterNo,
    correlationId: placed.orderId,
    payload: {
      orderId: placed.orderId, orderNo: placed.orderNo, orderGroupId,
      patientId: input.patientId, encounterNo: input.encounterNo, itemIds: placed.itemIds,
      invoiceId: invoiceResult.invoiceId, invoiceNo: invoiceResult.invoiceNo, chargeReason,
    },
  }));

  /**
   * (7) DD15 / 02 I3 — A WALK-IN NOBODY COULD ATTRIBUTE. The order still stands and the referrer
   * column still carries an id (the sentinel, if the counter chose none), because the BICONDITIONAL
   * CHECK admits no `external_prescription` order without one. The flag is what a commission review
   * counts; leaving the column null would make the desk unusable for walk-ins rather than
   * flagging one.
   */
  if (input.authority === "external_prescription" && input.attributionConfirmed !== true) {
    await appendEvent(tx, labAttributionUnverifiedFlagged.make({
      actor,
      patientId: input.patientId,
      correlationId: placed.orderId,
      payload: {
        orderId: placed.orderId, patientId: input.patientId,
        referrerName: input.referrerName ?? null,
        reason: "no prescription image and no telephonic confirmation at the counter",
      },
    }));
  }

  return {
    encounterNo: input.encounterNo,
    orderId: placed.orderId,
    orderNo: placed.orderNo,
    orderGroupId,
    itemIds: placed.itemIds,
    invoice: {
      draftId,
      invoiceId: invoiceResult.invoiceId,
      invoiceNo: invoiceResult.invoiceNo,
      netPayablePaise: invoiceResult.totals.netPayablePaise,
      receiptId: invoiceResult.receiptId,
      receiptNo: invoiceResult.receiptNo,
      creditExtended: invoiceResult.creditExtended,
    },
    reflexConsent: input.reflexConsent === true,
    duplicates: { acknowledged, warnings },
  };
}

export type AddOnOrderInput = {
  /** An item on the OPEN order the doctor is adding to. Its group is what the new order joins. */
  parentItemId: string;
  serviceIds: readonly string[];
  /** DD9 / E14 — the tube the add-on should run on, when the serum is still in the fridge. */
  specimenId?: string;
  orderingClinicianId: string;
  priority?: LabPriority;
  draftId?: string;
  receipt?: IssueInvoiceInput["receipt"];
  credit?: { reason: string; approvalId?: string };
  placedAt?: Date;
};

/**
 * DD9 — **AN ADD-ON IS A NEW ORDER IN THE SAME GROUP, NEVER A ROW APPENDED TO THE PARENT (A6).**
 *
 * The tempting implementation is one `INSERT INTO order_items` against the open parent order. It is
 * the one write in this module with no CAS and no guard: `order_items` is the envelope's table, the
 * envelope's own writer is `placeOrder`, and appending behind its back means no `order.placed`, no
 * authority resolution, no permission check and no duplicate record — and the parent's own item
 * count silently changes under a ward screen that already read it (phase 0 §6A.5/§6A.7).
 *
 * So it goes back through `deskOrder`, which is also what makes the money right: a new order is a
 * new invoice, `charge_reason = 'lab_addon'`, and E22's "paid for 5, doctor added 2" is two
 * documents rather than one amended one.
 */
export async function addOnOrder(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: AddOnOrderInput,
  now: Date = new Date(),
): Promise<DeskOrderResult> {
  const parentItem = (await tx
    .select({ orderId: orderItems.orderId })
    .from(orderItems)
    .where(eq(orderItems.id, input.parentItemId)))[0];
  if (!parentItem) {
    throw new LabError("unknown_item", `no order item ${input.parentItemId} to add on to`);
  }
  const parentOrder = (await tx
    .select({
      orderGroupId: orders.orderGroupId, patientId: orders.patientId, encounterNo: orders.encounterNo,
      serviceDate: orders.serviceDate, status: orders.status, kind: orders.kind,
    })
    .from(orders)
    .where(eq(orders.id, parentItem.orderId)))[0];
  if (!parentOrder || parentOrder.kind !== "lab") {
    throw new LabError("unknown_item", `order item ${input.parentItemId} is not on a lab order`);
  }
  /** A closed or cancelled order takes no additions: the act it recorded is over (E16's neighbour). */
  if (parentOrder.status !== "open") {
    throw new LabError(
      "item_not_cancellable",
      `order for item ${input.parentItemId} is ${parentOrder.status} — an add-on joins an OPEN act`,
    );
  }

  /**
   * E14 — THE SERUM MAY ALREADY BE GONE. `disposed_at` is the fact that decides it, and the refusal
   * names the TUBE rather than the test: the add-on is still legitimate, it just needs a fresh draw,
   * and T5's recollection is the path. Billing it as new is DD9 unchanged.
   */
  if (input.specimenId) {
    const specimen = (await tx
      .select({ disposedAt: labSpecimens.disposedAt, specimenNo: labSpecimens.specimenNo })
      .from(labSpecimens)
      .where(eq(labSpecimens.id, input.specimenId)))[0];
    if (!specimen) throw new LabError("unknown_specimen", `no specimen ${input.specimenId}`);
    if (specimen.disposedAt !== null) {
      throw new LabError(
        "addon_specimen_disposed",
        `specimen ${specimen.specimenNo} was disposed of at ${specimen.disposedAt.toISOString()} — ` +
          "the add-on needs a fresh draw",
      );
    }
  }

  /**
   * THE SAME GROUP, A NEW ORDER. `orderGroupId` is the parent's, which is what makes "the rest of
   * this clinical act" (`orders_group_idx`) still answer with both orders — and what lets T5 print
   * ONE tube for the whole group when the containers match.
   */
  return await deskOrder(
    tx,
    actor,
    decls,
    {
      patientId: parentOrder.patientId,
      encounterNo: parentOrder.encounterNo,
      serviceDate: parentOrder.serviceDate,
      orderingClinicianId: input.orderingClinicianId,
      orderGroupId: parentOrder.orderGroupId,
      priority: input.priority,
      items: input.serviceIds.map((serviceId) => ({ serviceId })),
      chargeReason: "lab_addon",
      itemOrigin: "addon",
      draftId: input.draftId,
      receipt: input.receipt,
      credit: input.credit,
      placedAt: input.placedAt,
      /**
       * THE ADD-ON IS THE DUPLICATE THE DOCTOR JUST ASKED FOR. Running the detector here would
       * refuse every add-on of a test already on the parent order — which is E22's normal case, not
       * a mistake — so the acknowledgement is implicit in the act of adding, and the ITEM still
       * records what it repeats through `origin`/`duplicate_of_item_id` below.
       */
      acknowledgedDuplicates: await (async () => {
        const found = await duplicateWarnings(tx, actor, parentOrder.patientId, input.serviceIds, now);
        return found.map((w) => w.duplicateOfItemId);
      })(),
    },
    now,
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════ */
/* PLAN 17c T1 — THE RECEPTION SEAT'S RAILS: one field with three doors, the Rx lines, the walk-in */
/* ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * One line of the consult's prescription, joined to the catalogue it will be drawn from.
 * `advisedTestItems` (17a T4) is the converter — it shipped with no caller (17c §2 row 1); this is
 * the first. `orderable` is null when the doctor advised something this laboratory does not run.
 */
export type DeskAdvisedLine = {
  serviceId: string;
  code: string;
  name: string;
  pricePaise: number;
  orderable: { container: string; specimenType: string; consentRequired: boolean; sensitive: boolean; requiresFasting: boolean } | null;
  /** A lab item ALREADY placed for this service on this visit — the seat shows it, never re-orders it. */
  alreadyOrderedItemId: string | null;
};

export type DeskFindHit = {
  matchedOn: "token" | "visit" | "order" | "uhid" | "mobile" | "name";
  patient: {
    id: string; uhid: string;
    /** Through the alias rule — a sealed patient's legal name never leaves this reader. */
    display: string;
    administrativeGender: string; dob: string | null; restricted: boolean;
  };
  visit: {
    encounterId: string; encounterNo: string; serviceDate: string; status: string;
    tokenNo: number | null; doctorName: string | null;
    /** The `users.id` behind the visit's doctor — what `orderingClinicianId` wants. */
    doctorUserId: string | null;
    departmentName: string | null;
    referrerName: string | null;
    advised: DeskAdvisedLine[];
  } | null;
  /** Lab orders already standing on that visit. */
  orders: { orderId: string; orderNo: string; status: string; itemCount: number }[];
};

/** The three doors, decided by SHAPE so a typed name can never be mistaken for a token. */
const TOKEN_RE = /^T-?(\d{1,5})$/i;
const VISIT_RE = /^V\d{6,}$/i;
const ORDER_RE = /^L\d{6,}$/i;

async function todaysEncounterFor(exec: Db | Tx, patientId: string, serviceDate: string): Promise<EncounterRow | null> {
  const rows = await (exec as Db)
    .select()
    .from(opdEncounters)
    .where(and(eq(opdEncounters.patientId, patientId), eq(opdEncounters.serviceDate, serviceDate)))
    .orderBy(desc(opdEncounters.openedAt))
    .limit(1);
  return rows[0] ?? null;
}

async function advisedLinesFor(exec: Db | Tx, encounter: EncounterRow): Promise<DeskAdvisedLine[]> {
  const advised = (encounter.advisedTests ?? []) as AdvisedTest[];
  if (advised.length === 0) return [];
  const items = advisedTestItems(advised);
  const serviceIds = [...new Set(items.map((i) => i.serviceId))];
  const orderables = await (exec as Db)
    .select()
    .from(labOrderables)
    .where(inArray(labOrderables.serviceId, serviceIds));
  const byService = new Map(orderables.map((o) => [o.serviceId, o]));
  const placed = await (exec as Db)
    .select({ id: orderItems.id, serviceId: orderItems.serviceId, status: orderItems.status })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orders.encounterNo, encounter.visitNo), eq(orders.kind, "lab"), inArray(orderItems.serviceId, serviceIds)));
  const placedFor = new Map<string, string>();
  for (const p of placed) if (p.status !== "cancelled" && !placedFor.has(p.serviceId)) placedFor.set(p.serviceId, p.id);
  return advised.map((a) => {
    const o = byService.get(a.serviceId);
    return {
      serviceId: a.serviceId, code: a.code, name: a.name, pricePaise: a.pricePaise,
      orderable: o
        ? { container: o.container, specimenType: o.specimenType, consentRequired: o.consentRequired,
            sensitive: o.sensitive, requiresFasting: o.requiresFasting }
        : null,
      alreadyOrderedItemId: placedFor.get(a.serviceId) ?? null,
    };
  });
}

async function hitFor(
  exec: Db | Tx, actor: Actor, matchedOn: DeskFindHit["matchedOn"], patientId: string,
  encounter: EncounterRow | null, tokenNo: number | null,
): Promise<DeskFindHit | null> {
  const [summary] = await getPatientSummaries(exec as Db, actor, [patientId]);
  if (!summary) return null;
  const [sealedRow] = await (exec as Db).select({ sealed: patients.isConfidential }).from(patients).where(eq(patients.id, summary.id));
  const patient: DeskFindHit["patient"] = {
    id: summary.id, uhid: summary.uhid,
    display: summary.restricted ? (summary.alias ?? "—") : (summary.name ?? "—"),
    administrativeGender: summary.administrativeGender,
    dob: summary.dob ? summary.dob.toISOString().slice(0, 10) : null,
    restricted: summary.restricted,
  };
  if (!encounter) return { matchedOn, patient, visit: null, orders: [] };
  const [doctor] = encounter.doctorId === null ? [undefined]
    : await (exec as Db).select({ displayName: opdDoctors.displayName, userId: opdDoctors.userId }).from(opdDoctors).where(eq(opdDoctors.id, encounter.doctorId));
  const [dept] = encounter.departmentId === null ? [undefined]
    : await (exec as Db).select({ name: opdDepartments.name }).from(opdDepartments).where(eq(opdDepartments.id, encounter.departmentId));
  let resolvedToken = tokenNo;
  if (resolvedToken === null) {
    const [entry] = await (exec as Db)
      .select({ tokenNo: opdQueueEntries.tokenNo })
      .from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounter.id))
      .orderBy(desc(opdQueueEntries.seq)).limit(1);
    resolvedToken = entry?.tokenNo ?? null;
  }
  const standing = await (exec as Db)
    .select({ orderId: orders.id, orderNo: orders.orderNo, status: orders.status, itemCount: sql<number>`count(${orderItems.id})::int` })
    .from(orders)
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(and(eq(orders.encounterNo, encounter.visitNo), eq(orders.kind, "lab")))
    .groupBy(orders.id, orders.orderNo, orders.status);
  /**
   * The Rx lines are clinical content read off the visit, so the read is logged the way
   * `getVisit` logs its own (`opd.visit`), once per visit returned — never per keystroke, because
   * the seat asks on Enter.
   */
  await recordPhiAccess(exec as Db, {
    /** Pass 1 F8 — `sealed` is the PATIENT's fact, not the reader's (`getReport`'s rule). */
    actor, patientId: summary.id, surface: "opd.visit", encounterId: encounter.id, sealed: sealedRow?.sealed ?? false, reason: null,
  });
  return {
    matchedOn, patient,
    visit: {
      encounterId: encounter.id, encounterNo: encounter.visitNo, serviceDate: encounter.serviceDate,
      status: encounter.status, tokenNo: resolvedToken,
      doctorName: doctor?.displayName ?? null, doctorUserId: doctor?.userId ?? null, departmentName: dept?.name ?? null,
      referrerName: encounter.referrerName ?? null,
      advised: await advisedLinesFor(exec, encounter),
    },
    orders: standing,
  };
}

/**
 * ONE FIELD, THREE DOORS (17c D4). `T-118` is today's queue token; `V…` a visit; `L…` an order;
 * anything else is a patient search, which returns CANDIDATES the clerk confirms by name — names
 * confirm, they never select (design edge case 2: three Sunita Devis on one morning).
 *
 * A token is per doctor-day (`opd_queue_entries.token_no`), so two doctors' 118s are two hits and
 * the seat shows both; the mutant this guards against is a token matched on the NAME beside it.
 */
/**
 * Pass 1 F6 — a laboratory with TWO active pathologists cannot open a walk-in without naming one
 * (`openLabWalkinInTx` refuses to let the counter choose). The seat asks the clerk; this is the list.
 */
export async function labDoctors(db: Db): Promise<{ id: string; displayName: string }[]> {
  const [dept] = await db.select({ id: opdDepartments.id }).from(opdDepartments).where(eq(opdDepartments.code, "LAB"));
  if (!dept) return [];
  return db.select({ id: opdDoctors.id, displayName: opdDoctors.displayName }).from(opdDoctors)
    .where(and(eq(opdDoctors.departmentId, dept.id), eq(opdDoctors.active, true))).orderBy(asc(opdDoctors.id));
}

export async function deskFind(db: Db, actor: Actor, q: string, serviceDate: string): Promise<DeskFindHit[]> {
  await assertMayDesk(db, actor);
  const query = q.trim();
  if (query.length === 0) return [];
  const token = TOKEN_RE.exec(query);
  if (token) {
    const n = Number(token[1]);
    const rows = await db
      .select({ encounter: opdEncounters, tokenNo: opdQueueEntries.tokenNo })
      .from(opdQueueEntries)
      .innerJoin(opdEncounters, eq(opdEncounters.id, opdQueueEntries.encounterId))
      .where(and(eq(opdQueueEntries.tokenNo, n), eq(opdEncounters.serviceDate, serviceDate)))
      .orderBy(desc(opdQueueEntries.seq));
    const seen = new Set<string>();
    const hits: DeskFindHit[] = [];
    for (const r of rows) {
      if (seen.has(r.encounter.id) || r.encounter.status === "abandoned") continue;
      seen.add(r.encounter.id);
      const hit = await hitFor(db, actor, "token", r.encounter.patientId, r.encounter, r.tokenNo);
      if (hit) hits.push(hit);
    }
    return hits;
  }
  if (VISIT_RE.test(query)) {
    const encounter = await getEncounter(db, query.toUpperCase());
    if (!encounter) return [];
    const hit = await hitFor(db, actor, "visit", encounter.patientId, encounter, null);
    return hit ? [hit] : [];
  }
  if (ORDER_RE.test(query)) {
    const [order] = await db.select().from(orders).where(and(eq(orders.orderNo, query.toUpperCase()), eq(orders.kind, "lab")));
    if (!order) return [];
    const encounter = await getEncounter(db, order.encounterNo);
    const hit = await hitFor(db, actor, "order", order.patientId, encounter, null);
    return hit ? [hit] : [];
  }
  const people = await searchPatients(db, actor, query, 8);
  const hits: DeskFindHit[] = [];
  for (const p of people) {
    const encounter = await todaysEncounterFor(db, p.id, serviceDate);
    const lane = p.matchedOn.includes("uhid") ? "uhid" : p.matchedOn.includes("mobile") ? "mobile" : "name";
    const hit = await hitFor(db, actor, lane, p.id, encounter, null);
    if (hit) hits.push(hit);
  }
  return hits;
}

/** What the chair will draw for a basket: tubes grouped by container, in ORDER OF DRAW (D5). */
export type TubePlanRow = { container: string; specimenType: string; codes: string[] };

/**
 * CLSI order of draw, keyed on the catalogue's container vocabulary: culture bottles, then citrate
 * (blue), serum (SST / plain red), heparin (green), EDTA (lavender), fluoride (grey); everything
 * that is not a blood tube comes after. One additive never reaches the next tube.
 */
export const DRAW_ORDER: readonly string[] = [
  "blood_culture", "citrate", "sst", "plain", "heparin", "edta", "fluoride",
];
export function drawRank(container: string): number {
  const i = DRAW_ORDER.indexOf(container);
  return i === -1 ? DRAW_ORDER.length : i;
}

export async function tubePlan(exec: Db | Tx, serviceIds: readonly string[]): Promise<TubePlanRow[]> {
  if (serviceIds.length === 0) return [];
  const rows = await (exec as Db)
    .select({ serviceId: labOrderables.serviceId, code: labOrderables.code, container: labOrderables.container, specimenType: labOrderables.specimenType })
    .from(labOrderables)
    .where(inArray(labOrderables.serviceId, [...new Set(serviceIds)]));
  const byService = new Map(rows.map((r) => [r.serviceId, r]));
  const plan = new Map<string, TubePlanRow>();
  for (const id of serviceIds) {
    const o = byService.get(id);
    if (!o) continue;
    const key = `${o.container}|${o.specimenType}`;
    const row = plan.get(key) ?? { container: o.container, specimenType: o.specimenType, codes: [] };
    if (!row.codes.includes(o.code)) row.codes.push(o.code);
    plan.set(key, row);
  }
  return [...plan.values()].sort((a, b) => drawRank(a.container) - drawRank(b.container));
}

/**
 * THE WALK-IN DOOR. `openLabWalkin` (17a A9) shipped with no caller: a patient with an outside
 * prescription and no visit could not be ordered through any route. This opens the `V` visit in
 * the LAB department under the pathologist of record AND places the order, in the caller's one
 * transaction (DD6 — a refused order leaves no visit behind). Authority defaults to
 * `external_prescription` and the charge reason to `lab_walkin`; the ordering clinician is the
 * visit's doctor unless the caller names one.
 */
export type DeskWalkinInput = Omit<DeskOrderBase, "encounterNo" | "orderingClinicianId" | "chargeReason"> & {
  orderingClinicianId?: string;
  walkIn: { referrerName?: string; doctorId?: string; intendedPayer?: "self" | "tpa" | "pmjay" | "corporate" };
  externalReferrerId?: string | null;
  referrerName?: string | null;
  attributionConfirmed?: boolean;
  chargeReason?: "lab_walkin";
};

export async function deskWalkinOrder(
  tx: Tx,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: DeskWalkinInput,
  now: Date = new Date(),
): Promise<DeskOrderResult> {
  await assertMayDesk(tx, actor);
  const canonical = await resolvePatientId(tx, input.patientId);
  if (!canonical) throw new LabError("unknown_service", `unknown patient ${input.patientId} — a walk-in is a person first`);
  const chainIds = [canonical, ...(await listMergedLoserIds(tx, canonical))];
  const visit = await openLabWalkinInTx(tx, actor, {
    patientId: canonical, chainIds,
    doctorId: input.walkIn.doctorId,
    intendedPayer: input.walkIn.intendedPayer,
    referrerName: input.walkIn.referrerName ?? input.referrerName ?? undefined,
  }, now);
  let clinicianId = input.orderingClinicianId;
  if (clinicianId === undefined) {
    const [doctor] = visit.encounter.doctorId === null ? [undefined]
      : await tx.select({ userId: opdDoctors.userId }).from(opdDoctors).where(eq(opdDoctors.id, visit.encounter.doctorId));
    clinicianId = doctor?.userId ?? actor.id;
  }
  const rest: Omit<DeskWalkinInput, "walkIn"> & { walkIn?: unknown } = { ...input };
  delete rest.walkIn;
  const order: DeskOrderInput = {
    ...(rest as Omit<DeskWalkinInput, "walkIn">),
    patientId: canonical,
    encounterNo: visit.encounter.visitNo,
    orderingClinicianId: clinicianId,
    chargeReason: "lab_walkin",
    authority: "external_prescription",
    externalReferrerId: input.externalReferrerId ?? null,
    referrerName: input.walkIn.referrerName ?? input.referrerName ?? null,
    attributionConfirmed: input.attributionConfirmed,
  };
  return deskOrder(tx, actor, decls, order, now);
}
