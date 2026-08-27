import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * The materials module's event surface — `entity.verb_past`, module carried separately (the `opd`,
 * `membership` and `formulary` grammar, unchanged).
 *
 * ═══ THIS FILE IS THE INTERFACE PLAN 15 IMPORTS, AND `consignmentDeployed` IS THE FROZEN HALF ═══
 *
 * The roadmap's *"15 consumes 14's consignment interface"* is built here as the thing it actually
 * is: ONE zod object in ONE file, owned by the module that CONSUMES it. Plan 15's mini-OT imports
 * `consignmentDeployed` and appends it inside its scan-on-use transaction; **it never redefines the
 * name and it never re-declares the payload.** A second definition would be two schemas for one
 * fact, and the one that drifted would be the one nobody was reading (§2.54).
 *
 * DD13 froze the payload at write time and this is it, verbatim. Widening it later is additive and
 * cheap; renaming or re-typing a field is a break in a contract another plan is already written
 * against, so the fields below carry their reasons.
 *
 * ═══ FIVE NAMES REUSED FROM THE SPEC's CATALOG, SEVEN NEW (DD12) ═══
 *
 * Reused from §10.6 / §11.10: `grn.received`, `grn.rejected`, `material.issued`, `batch.recalled`,
 * `batch.expiring`. New under the `entity.verb_past` lint, module `materials`: `item.registered`,
 * `item.updated`, `vendor.registered`, `vendor.updated`, `vendor.status_changed`,
 * `grn.line_rejected`, `material.received`, `material.discrepancy_flagged`, `material.consumed`,
 * and `consignment.deployed` (defined here, EMITTED BY PLAN 15).
 *
 * **`near_expiry.accepted` is deliberately NOT an event.** It is `approval.granted` on a
 * `materials_near_expiry_acceptance` subject, and the GRN row carries the `approval_id`. A second
 * name for a fact the approvals engine already emits is a second place to look for the same thing.
 *
 * ═══ A MASTER THAT EMITS NOTHING IS AN AUDIT HOLE ═══
 *
 * `item.registered` / `item.updated` and the three `vendor.*` names have no SUBSCRIBER in this
 * phase, and they ship anyway — Plan 13's DD8 reasoning. The item and vendor masters decide what a
 * hospital may buy and who it may buy from; "who changed the MRP ceiling on this implant, and
 * when" is a question an auditor will ask and the event stream is the only place that answers it.
 *
 * **The bank change is a `vendor.updated` with `changed: ["bank"]` and NO BANK VALUES IN THE
 * PAYLOAD** (DD4/DD12). The event stream is read by consumers, replayed into projections and dumped
 * into logs; an account number in it is an account number in all three, for ever, outside the
 * masking `getVendor` applies and outside the change-control table that is supposed to be its only
 * home. The payload schema below makes that structural rather than a convention.
 */
const MODULE = "materials";
const id = z.string().min(1);
/** Integer base units — DD7. No float reaches an event payload any more than it reaches a column. */
const qty = z.number().int();
/** Integer paise — DD7. */
const paise = z.number().int();

// ═══════════════════════════════════ THE MASTERS ═══════════════════════════════════

export const itemRegistered = defineEvent("item.registered", MODULE, z.object({
  itemId: id, code: z.string().min(1), name: z.string().min(1), itemClass: z.string().min(1),
  baseUom: z.string().min(1), formularyMedicineId: id.nullable(),
}));

export const itemUpdated = defineEvent("item.updated", MODULE, z.object({
  itemId: id, changed: z.array(z.string()).min(1),
}));

export const vendorRegistered = defineEvent("vendor.registered", MODULE, z.object({
  vendorId: id, code: z.string().min(1), legalName: z.string().min(1),
  gstin: z.string().nullable(),
}));

/**
 * `changed` is a list of FIELD NAMES and never a list of values. The bank change is
 * `changed: ["bank"]` — see the header for why the values cannot travel.
 */
export const vendorUpdated = defineEvent("vendor.updated", MODULE, z.object({
  vendorId: id, changed: z.array(z.string()).min(1),
}));

/**
 * A lifecycle transition, separate from `vendor.updated` because the two answer different
 * questions: `updated` is "the paperwork moved", `status_changed` is "we may or may not buy from
 * them now". 14b's scorecard and 14c's payment run both read the second and neither reads the
 * first. `reason` is populated for a blacklist (one of `BLACKLIST_REASONS`) and null otherwise.
 */
export const vendorStatusChanged = defineEvent("vendor.status_changed", MODULE, z.object({
  vendorId: id, fromStatus: z.string().min(1), toStatus: z.string().min(1),
  reason: z.string().nullable(),
}));

// ═══════════════════════════════════ THE GRN GATE ═══════════════════════════════════

export const grnReceived = defineEvent("grn.received", MODULE, z.object({
  grnId: id, grnNo: z.string().min(1), vendorId: id, storeResourceId: id,
  source: z.string().min(1), challanNo: z.string().min(1), challanDate: z.string().min(1),
  acceptedLines: z.number().int(), rejectedLines: z.number().int(),
  /** Null unless a `near_expiry` line forced the DD10 approval. */
  approvalId: id.nullable(),
}));

/** Every line failed the gate: nothing was posted and NO ledger row exists (T6's acceptance). */
export const grnRejected = defineEvent("grn.rejected", MODULE, z.object({
  grnId: id, grnNo: z.string().min(1), vendorId: id, rejectedLines: z.number().int(),
}));

/**
 * ONE PER REJECTED LINE, carrying the RULE that fired rather than a sentence. Readers: the GRN
 * screen's rejection list (T9) and 14b's vendor scorecard, which counts rejections by rule — a
 * vendor whose deliveries fail rule 5 every month is a different commercial problem from one whose
 * deliveries fail rule 7, and a free-text reason cannot be counted.
 */
export const grnLineRejected = defineEvent("grn.line_rejected", MODULE, z.object({
  grnId: id, grnLineId: id, itemId: id, rule: z.string().min(1),
  qtyRejectedBase: qty, batchNo: z.string().nullable(),
}));

// ═══════════════════════════════════ MOVEMENT ═══════════════════════════════════

export const materialIssued = defineEvent("material.issued", MODULE, z.object({
  transferId: id, fromResourceId: id, toResourceId: id,
  lines: z.array(z.object({ batchId: id, itemId: id, qtyBase: qty })).min(1),
}));

export const materialReceived = defineEvent("material.received", MODULE, z.object({
  transferId: id, fromResourceId: id, toResourceId: id,
  lines: z.array(z.object({ transferLineId: id, batchId: id, qtyReceived: qty })).min(1),
}));

/**
 * DD9 — a shortfall at receive. Fired in the SAME transaction as the receive (§11.10:
 * "discrepancies surface same-hour"), and the gap STAYS in `IN-TRANSIT` rather than being written
 * down (A18). Reader: 14c's variance register, and the transfer screen's red row today.
 */
export const materialDiscrepancyFlagged = defineEvent("material.discrepancy_flagged", MODULE, z.object({
  transferId: id, fromResourceId: id, toResourceId: id,
  gaps: z.array(z.object({
    transferLineId: id, batchId: id, qtyIssued: qty, qtyReceived: qty, qtyShort: qty,
  })).min(1),
}));

// ═══════════════════════════════════ RECALL AND EXPIRY ═══════════════════════════════════

/**
 * DD14 — ONE event for a ONE-ACTION freeze, and it names EVERY location (§11.10: "one-action freeze
 * at every location"). A12's mutant freezes only the store the caller passed, and the `locations`
 * array is what makes that visible in the stream as well as in the balances.
 */
export const batchRecalled = defineEvent("batch.recalled", MODULE, z.object({
  batchId: id, itemId: id, batchNo: z.string().min(1), reason: z.string().min(1),
  locations: z.array(z.object({ storeResourceId: id, qtyFrozen: qty })),
}));

/**
 * DD14 — an event and a WORKLIST ROUTE, deliberately NOT an alert. The alerts consumer routes three
 * kinds (`kernel/alerts/consumer.ts`) and adding a fourth is a kernel change this phase has no
 * ruling for; doc 09 §9's Expiry Watchman fails open to "reports still queryable", which is
 * `GET /materials/expiring` (T8). §10.3's "structure everywhere, alerts selective", and 11g's
 * record-only-at-go-live posture.
 *
 * Idempotent per `(batch, threshold)` via `stock_batches.expiry_notified_thresholds`, so a daily
 * job does not re-announce 90 days every morning for a month.
 */
export const batchExpiring = defineEvent("batch.expiring", MODULE, z.object({
  batchId: id, itemId: id, batchNo: z.string().min(1), expiryDate: z.string().min(1),
  thresholdDays: z.number().int(), qtyOnHandTotal: qty,
}));

// ═══════════════════════════ THE CONSIGNMENT INTERFACE (DD13) ═══════════════════════════

/**
 * **FROZEN AT WRITE TIME FOR PLAN 15. IN.**
 *
 * Plan 15's mini-OT appends this inside its scan-on-use transaction; the materials manifest
 * subscribes to it (T7) and `materials.consumption` handles it, idempotently by event id through
 * `event_idempotency` (the accrual consumer's shape).
 *
 * Field by field, because another plan is written against these names:
 *   · `lotId`            — WHICH consignment lot this came out of. The deployment is refused
 *                          `lot_exhausted` when `received − deployed − returned` cannot cover it
 *                          (A20), and that check is the reason the lot travels rather than being
 *                          looked up from the batch: one batch can back several lots.
 *   · `batchId`          — the physical pile. `itemId` travels beside it rather than being derived,
 *                          so a consumer can reject a mismatched pair instead of trusting one.
 *   · `storeResourceId`  — WHERE it was taken from. The OT's consignment bin is a `store` like any
 *                          other, and the balance that moves is `(store, batch)`.
 *   · `qtyBase`          — INTEGER, in the item's base UoM (DD7). Never "1 box".
 *   · `patientId` / `encounterId` — who it went into. Both required: an implant with no patient is
 *                          not a consignment deployment, it is a stock issue, and that is
 *                          `issueStock`.
 *   · `caseRef`          — the OT case, as `{ type, id }`. A polymorphic reference because Plan 15
 *                          owns the case table and this module must not import it.
 *   · `stickerRef`       — the implant sticker scanned onto the patient's record. Optional because
 *                          not every consignment item carries one (bone cement does not).
 *   · `occurredAt`       — WHEN IT HAPPENED, which is not when it was processed. A21 turns on
 *                          exactly this: the price regulation that travels out must be the one
 *                          effective at `occurredAt`, not at `now()`.
 */
export const consignmentDeployed = defineEvent("consignment.deployed", MODULE, z.object({
  lotId: id,
  batchId: id,
  itemId: id,
  storeResourceId: id,
  qtyBase: qty.positive(),
  patientId: id,
  encounterId: id,
  caseRef: z.object({ type: z.string().min(1), id }),
  stickerRef: z.string().min(1).optional(),
  occurredAt: z.string().min(1),
}));

/**
 * **FROZEN AT WRITE TIME FOR PLAN 15. OUT.**
 *
 * What the consumption consumer emits after it has locked the balance, appended the `consume`
 * ledger row and incremented `consignment_lots.qty_deployed` — all in one transaction.
 *
 * ═══ IT POSTS NO CHARGE, AND THAT IS A DECISION WITH A REASON (DD13, § 4A item 3) ═══
 *
 * Billing has NO event-driven charge path today: invoices are issued from a counter draft
 * (`invoices.ts:638`) and the daily close's `orphanScan` is the §11.11 orphan REPORT, not a poster.
 * So this event CANNOT post a charge, and inventing a private poster here would put a money writer
 * in the stores module. What it does instead is carry **every fact a charge will need**, so that
 * the day billing grows a chargeables spine this is already the event it consumes.
 *
 * ═══ EVERY MONEY FIELD CARRIES ITS UNIT IN ITS NAME OR BESIDE IT — CLOSE REVIEW M3 ═══
 *
 * The first version carried `mrpPaise` (per PACK, with `mrpUom`) beside `ceilingPaise` — which was
 * silently converted to a PER-BASE-UNIT figure — and said nothing about the difference. Plan 15's
 * discharge bill applies `min(tariff, MRP, ceiling)`; comparing a per-box MRP with a per-each
 * ceiling on an implant sold in fives is a **factor-of-five error in a patient's bill**, in
 * whichever direction the numbers happen to fall.
 *
 * **The fixture hid it exactly as §2.102 predicts**: `consumption.test.ts` gave the batch and the
 * regulation `mrpUom: "each"` — the BASE unit — so every conversion was a no-op and the mismatch
 * was invisible. `mrpUom === baseUom` is a SEVENTH coinciding field the phase's standing note does
 * not name, and it is the one that hides the money arithmetic.
 *
 * So the payload now carries, explicitly:
 *   · `mrpPaise` + `mrpUom` — the price AS PRINTED, on the pack it is printed on;
 *   · `mrpPaisePerBase` — the same price per BASE unit, or null when it does not divide evenly;
 *   · `ceilingPaisePerBase` — the ceiling per BASE unit, the unit now in the NAME (`qc.ts` already
 *     called its own field this, and the frozen payload had dropped the suffix).
 *
 * A consumer comparing the two `…PerBase` figures is comparing like with like without needing the
 * item's UoM table at all, which is the property a bill actually needs.
 *
 * `ceilingPaisePerBase` is the DPCO/NPPA ceiling **effective at `occurredAt`** or null — A21's
 * whole subject, and the mutant is a consumer that asks for the regulation at processing time.
 *
 * The bill for a day-care case is composed by Plan 15 at discharge from `consumptionsFor(encounterId)`
 * — the read interface T7 ships — with billing applying the `regulated` clamp exactly as it does today.
 */
export const materialConsumed = defineEvent("material.consumed", MODULE, z.object({
  ledgerEntryId: id,
  itemId: id,
  batchId: id,
  ownership: z.enum(["owned", "consignment", "loaner", "donated"]),
  /** The vendor who owns the stock. Null for `owned` — nobody outside is owed anything. */
  vendorId: id.nullable(),
  qtyBase: qty.positive(),
  patientId: id,
  encounterId: id,
  caseRef: z.object({ type: z.string().min(1), id }),
  /** AS PRINTED, on `mrpUom`'s pack. */
  mrpPaise: paise.nullable(),
  mrpUom: z.string().nullable(),
  /** The same price per BASE unit; null when the MRP does not divide into whole paise (M3). */
  mrpPaisePerBase: paise.nullable(),
  /** The notified ceiling per BASE unit — the unit is in the name, deliberately (M3). */
  ceilingPaisePerBase: paise.nullable(),
  occurredAt: z.string().min(1),
}));

/**
 * The catalog, in source order. A later task that adds a `defineEvent` above adds it here too;
 * `manifests.test.ts`'s discipline applied to a list one module owns.
 */
export const MATERIALS_EVENTS = [
  itemRegistered, itemUpdated,
  vendorRegistered, vendorUpdated, vendorStatusChanged,
  grnReceived, grnRejected, grnLineRejected,
  materialIssued, materialReceived, materialDiscrepancyFlagged,
  batchRecalled, batchExpiring,
  consignmentDeployed, materialConsumed,
] as const;
