import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import {
  consignmentLots, grnLines, grns, stockBatches, vendorDocuments,
} from "../../kernel/db/schema";
import { DEEMED_SUPPLY_DAYS } from "./config";
import { NEAR_EXPIRY_APPROVAL_TYPE } from "./approval-types";
import { MaterialsError } from "./errors";
import { grnLineRejected, grnReceived, grnRejected } from "./events";
import { effectiveRegulation, itemUomRows, itemsByIds } from "./items";
import { getBatch, postMovements } from "./ledger";
import { qcLine } from "./qc";
import { requireStore } from "./stores";
import { assertVendorPurchasable, hasValidDocument } from "./vendors";
import { mrpPerBaseUnit, toBase } from "./uom";
import type { QcContext, RuleCode } from "./qc";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

export type GrnRow = typeof grns.$inferSelect;
export type GrnLineRow = typeof grnLines.$inferSelect;
export type GrnWithLines = GrnRow & { lines: GrnLineRow[] };

/**
 * PLAN 14 T6 / DD8 — **THE GRN GATE: capture, QC, the near-expiry approval, and post.**
 *
 * ═══ TWO STAGES, BECAUSE A LORRY CANNOT WAIT FOR A PHARMACIST (doc 09 §6.1) ═══
 *
 * `captureGrn` records what came off the vehicle so the vehicle can leave; `runGateQc` records the
 * verdict when somebody competent to give one arrives; `postGrn` moves the stock. **Capture and QC
 * may be the same USER in this phase** — the SoD pairs S10 names are PO-approver/receiver and
 * custodian/counter, neither of which exists until 14b/14c, and inventing a third pair here would
 * be a rule nobody ruled. The PERMISSIONS are nonetheless distinct (`grn.capture` vs `grn.qc`,
 * DD11), so the day a pair is ruled it is a `sod_pairs` row rather than a refactor.
 *
 * ═══ NOTHING MOVES UNTIL `postGrn`, AND THAT IS THE WHOLE SHAPE ═══
 *
 * A captured GRN writes no batch and no ledger row. A QC'd GRN writes no batch and no ledger row.
 * **`postGrn` is the only function here that touches stock**, and it does everything in one
 * transaction: find-or-create the batch per accepted line (A14), post the movements through the
 * ledger's own ordered lock, create the consignment lot where the source demands one, and emit.
 * A GRN that never posts leaves nothing behind but its own paperwork — which is what makes a
 * rejected delivery cost nothing to record.
 */

/**
 * The IST calendar date of an instant, `YYYY-MM-DD`.
 *
 * **Copied module-locally on purpose, and it is the `modules/billing/time.ts` precedent verbatim**:
 * cross-module internals are not importable (spec §4 — a module is reached only through its
 * `index.ts`), `istDate` lives in `modules/opd/time.ts`, and a goods-receipt date is not an OPD
 * concept. The duplication is deliberate and recorded here rather than smuggled.
 *
 * It is two lines of pure arithmetic — no `Intl`, no process TZ, no clock read — which is what
 * makes copying it safer than importing across a module boundary: there is nothing here that can
 * drift except the offset, and IST has no DST.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
export function istDay(at: Date): string {
  return new Date(Math.floor((at.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/** The context `qcLine` needs, assembled once per GRN rather than once per line. */
async function qcContextFor(
  tx: Tx,
  grn: GrnRow,
  itemId: string,
  batchNo: string | null,
  ownership: string,
): Promise<QcContext> {
  const items = await itemsByIds(tx, [itemId]);
  const item = items.get(itemId);
  const uoms = item === undefined ? [] : await itemUomRows(tx, itemId);

  // The ceiling in force ON THE CHALLAN DATE — not today. A delivery received against a January
  // challan is judged by January's gazette, and asking `now()` would apply a ceiling that did not
  // exist when the price was agreed.
  const at = new Date(`${grn.challanDate}T23:59:59Z`);
  const reg = item === undefined ? undefined : await effectiveRegulation(tx, itemId, at);
  /**
   * ═══ CLOSE REVIEW M7 — THE CONVERSION IS CAUGHT HERE, NOT ALLOWED TO ESCAPE ═══
   *
   * `mrpPerBaseUnit` THROWS `unknown_uom` on a ceiling that will not divide into whole paise per
   * base unit, or whose `mrpUom` is not one of the item's. This call was OUTSIDE any `try`, so the
   * throw left `qcContextFor`, left `runGateQc`, and reached the controller as a **404 on the
   * whole GRN** — one mistyped regulation aborting a twenty-line delivery.
   *
   * The failure is carried to `qcLine` as a FLAG instead, and rule 7 turns it into a per-line
   * `mrp_unconvertible` rejection. The two outcomes are kept apart deliberately: `null` means no
   * ceiling was notified (pass), the flag means one was and cannot be compared (reject).
   */
  let ceilingPaisePerBase: number | null = null;
  let ceilingUnconvertible = false;
  if (reg?.ceilingPaise !== null && reg?.ceilingPaise !== undefined) {
    try {
      ceilingPaisePerBase = mrpPerBaseUnit(
        uoms, reg.ceilingPaise,
        reg.mrpUom ?? uoms.find((u) => u.toBaseMultiplier === 1)?.uom ?? null,
      );
    } catch {
      ceilingUnconvertible = true;
    }
  }

  // Rule 8 — an EXISTING batch of this `(item, batch_no, ownership)` that is already frozen.
  let batchFrozen = false;
  if (batchNo !== null && batchNo.trim() !== "") {
    const existing = await findBatch(tx, itemId, batchNo, ownership);
    batchFrozen = existing?.recallStatus === "frozen";
  }

  // Rule 9 — O-8, and it is asked ONLY for a consignment challan.
  const hasConsignmentAgreement = grn.source !== "consignment_challan"
    ? true
    : await hasValidDocument(tx, grn.vendorId, "consignment_agreement", grn.challanDate);

  return {
    item: item === undefined ? undefined : {
      id: item.id, class: item.class, active: item.active, shelfLifeDays: item.shelfLifeDays,
    },
    uoms,
    ceilingPaisePerBase,
    ceilingUnconvertible,
    batchFrozen,
    hasConsignmentAgreement,
    source: grn.source,
    challanDate: grn.challanDate,
  };
}

/** The ownership a GRN's source produces. A consignment challan does not transfer title. */
function ownershipFor(source: string): string {
  return source === "consignment_challan" ? "consignment" : source === "donation" ? "donated" : "owned";
}

/** The `(item, lower(batch_no), ownership)` row, or `undefined`. DD5's key, in one place. */
async function findBatch(
  tx: Tx | Db, itemId: string, batchNo: string, ownership: string,
): Promise<typeof stockBatches.$inferSelect | undefined> {
  const rows = await tx.select().from(stockBatches).where(and(
    eq(stockBatches.itemId, itemId),
    sql`lower(${stockBatches.batchNo}) = ${batchNo.trim().toLowerCase()}`,
    eq(stockBatches.ownership, ownership),
  )).limit(1);
  return rows[0];
}

// ═══════════════════════════════════ CAPTURE ═══════════════════════════════════

export type CaptureLine = {
  itemId: string;
  uom: string;
  qtyInUom: number;
  batchNo?: string | null;
  mfgDate?: string | null;
  expiryDate?: string | null;
  mrpPaise?: number | null;
  mrpUom?: string | null;
  /** PER BASE UNIT (DD7). Zero for free goods. */
  unitCostPaise: number;
  freeGoods?: boolean;
  tempLogRef?: string | null;
};

/**
 * Records the delivery. Status `gate_qc`: captured, not judged, nothing moved.
 *
 * `qty_base` is computed HERE, once, through `uom.ts` — the single place a multiplier is applied
 * (DD7, A2). A line captured as "3 boxes" stores `qty_in_uom = 3, uom = 'box', qty_base = 300`, and
 * every later reader works in base units.
 *
 * `grnNo` comes from `EPISODE_SERIES.grn` rather than a private counter: one daily-number grammar
 * for the whole house is the reason that table exists.
 */
export async function captureGrn(
  tx: Tx,
  actor: Actor,
  input: {
    vendorId: string;
    source: string;
    storeResourceId: string;
    challanNo: string;
    challanDate: string;
    invoiceNo?: string | null;
    poRef?: string | null;
    lines: CaptureLine[];
    now?: Date;
    /** The IST calendar date the GRN number is series-numbered under. Defaults from `now`. */
    serviceDate?: string;
  },
): Promise<{ grnId: string; grnNo: string }> {
  if (input.lines.length === 0) {
    throw new MaterialsError("unknown_document", "a GRN must carry at least one line");
  }
  // The vendor must be purchasable BEFORE anything is written: a blacklisted supplier's delivery is
  // refused at the gate, not discovered at post.
  await assertVendorPurchasable(tx, input.vendorId);
  await requireStore(tx, input.storeResourceId);

  // `series.ts` requires a date ALREADY resolved to the hospital's day — "a date that has already
  // been resolved to the hospital's day must not be re-derived from an instant by a second piece of
  // code that might disagree about the offset". The caller may pass one; otherwise it is resolved
  // here, once.
  const serviceDate = input.serviceDate ?? istDay(input.now ?? new Date());
  const grnNo = await nextEpisodeNo(tx, "grn", serviceDate);
  const grnId = newId();

  await tx.insert(grns).values({
    id: grnId, grnNo, vendorId: input.vendorId, source: input.source,
    poRef: input.poRef ?? null, challanNo: input.challanNo, challanDate: input.challanDate,
    invoiceNo: input.invoiceNo ?? null, storeResourceId: input.storeResourceId,
    status: "gate_qc", capturedBy: actor.id,
    createdBy: actor.id, updatedBy: actor.id,
  });

  for (const line of input.lines) {
    const uoms = await itemUomRows(tx, line.itemId);
    if (uoms.length === 0) {
      throw new MaterialsError("unknown_item", `item ${line.itemId} not found`, { itemId: line.itemId });
    }
    // DD7's ONE conversion. Throws `unknown_uom` for a unit this item does not have — which is
    // rule 2 enforced at capture as well as at QC, because a quantity nobody can convert is not a
    // quantity worth recording.
    const qtyBase = toBase(uoms, line.uom, line.qtyInUom);
    await tx.insert(grnLines).values({
      id: newId(), grnId, itemId: line.itemId, uom: line.uom.trim(),
      qtyInUom: line.qtyInUom, qtyBase,
      batchNo: line.batchNo ?? null, mfgDate: line.mfgDate ?? null,
      expiryDate: line.expiryDate ?? null,
      mrpPaise: line.mrpPaise ?? null, mrpUom: line.mrpUom ?? null,
      unitCostPaise: line.unitCostPaise, freeGoods: line.freeGoods ?? false,
      tempLogRef: line.tempLogRef ?? null,
    });
  }
  return { grnId, grnNo };
}

// ═══════════════════════════════════ THE GATE ═══════════════════════════════════

/**
 * Every line through `qcLine`, in DD8's order. Writes the verdicts onto the lines and moves the
 * header to `accepted` / `partially_accepted` / `rejected`.
 *
 * A `near_expiry` line sets `nearExpiry = true` and is ACCEPTED at this stage — it is not a
 * rejection, it is a line that needs an approval before `postGrn` will move it (A17).
 */
export async function runGateQc(
  tx: Tx,
  actor: Actor,
  grnId: string,
): Promise<{ status: string; verdicts: { grnLineId: string; verdict: string; rule?: RuleCode }[] }> {
  const grn = await requireGrn(tx, grnId);
  if (grn.status !== "gate_qc" && grn.status !== "accepted" && grn.status !== "partially_accepted") {
    throw new MaterialsError(
      "already_received",
      `GRN ${grn.grnNo} is "${grn.status}" and its QC verdict is already recorded`,
      { status: grn.status },
    );
  }
  const lines = await tx.select().from(grnLines).where(eq(grnLines.grnId, grnId)).orderBy(asc(grnLines.id));
  const ownership = ownershipFor(grn.source);

  const verdicts: { grnLineId: string; verdict: string; rule?: RuleCode }[] = [];
  let accepted = 0;
  let rejected = 0;
  for (const line of lines) {
    const ctx = await qcContextFor(tx, grn, line.itemId, line.batchNo, ownership);
    const v = qcLine(ctx, {
      itemId: line.itemId, uom: line.uom, qtyBase: line.qtyBase,
      batchNo: line.batchNo, expiryDate: line.expiryDate,
      mrpPaise: line.mrpPaise, mrpUom: line.mrpUom,
      unitCostPaise: line.unitCostPaise, freeGoods: line.freeGoods,
    });
    verdicts.push({ grnLineId: line.id, verdict: v.verdict, ...(v.rule === undefined ? {} : { rule: v.rule }) });

    if (v.verdict === "reject") {
      rejected += 1;
      await tx.update(grnLines).set({
        qtyAcceptedBase: 0, qtyRejectedBase: line.qtyBase,
        rejectReason: v.rule ?? null, nearExpiry: false,
      }).where(eq(grnLines.id, line.id));
    } else {
      accepted += 1;
      await tx.update(grnLines).set({
        qtyAcceptedBase: line.qtyBase, qtyRejectedBase: 0,
        rejectReason: null, nearExpiry: v.verdict === "near_expiry",
      }).where(eq(grnLines.id, line.id));
    }
  }

  const status = accepted === 0 ? "rejected" : rejected === 0 ? "accepted" : "partially_accepted";
  await tx.update(grns).set({ status, qcBy: actor.id, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(grns.id, grnId));
  return { status, verdicts };
}

/**
 * Files the `materials_near_expiry_acceptance` approval for a GRN carrying at least one
 * `near_expiry` line, and records its id on the header.
 *
 * The subject is the GRN, so the approver opens the delivery they are deciding about. There is no
 * amount: what is being accepted is short-dated stock, not a sum of money (DD10).
 */
export async function requestNearExpiryAcceptance(
  tx: Tx,
  actor: Actor,
  grnId: string,
  note?: string,
): Promise<{ approvalId: string }> {
  const grn = await requireGrn(tx, grnId);
  const near = await tx.select({ id: grnLines.id }).from(grnLines)
    .where(and(eq(grnLines.grnId, grnId), eq(grnLines.nearExpiry, true)));
  if (near.length === 0) {
    throw new MaterialsError(
      "unknown_document",
      `GRN ${grn.grnNo} has no near-expiry line — there is nothing to accept`,
    );
  }
  const { approvalId } = await requestApproval(tx, actor, {
    typeKey: NEAR_EXPIRY_APPROVAL_TYPE,
    subject: { type: "grn", id: grnId },
    requestNote: note,
  });
  await tx.update(grns).set({ approvalId, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(grns.id, grnId));
  return { approvalId };
}

// ═══════════════════════════════════ POST ═══════════════════════════════════

/**
 * **THE ONLY FUNCTION HERE THAT MOVES STOCK.** One transaction:
 *
 *   · refuse `near_expiry_unapproved` if any accepted line is `near_expiry` and the header carries
 *     no GRANTED approval (A17 — **the check is on the approval's STATUS, not on `approval_id IS
 *     NOT NULL`**, because `approval_id` is set the moment the request is FILED);
 *   · per accepted line, find-or-create the `(item, batch_no, ownership)` batch (A14);
 *   · post every movement through `postMovements`, so ONE ordered lock covers the whole GRN;
 *   · create the `consignment_lots` row where the source demands one, with its §31(7) deadline;
 *   · emit `grn.received` once (or `grn.rejected`), and `grn.line_rejected` per rejected line.
 */
export async function postGrn(
  tx: Tx,
  actor: Actor,
  grnId: string,
  now: Date,
): Promise<{ status: string; ledgerEntryIds: string[] }> {
  const grn = await requireGrn(tx, grnId);
  if (grn.status === "posted") {
    throw new MaterialsError("already_received", `GRN ${grn.grnNo} is already posted`);
  }
  if (grn.status === "draft" || grn.status === "gate_qc") {
    /**
     * CLOSE REVIEW M8 — this threw `not_in_transit`, which `errors.ts` documents as
     * *"`receiveStock` against a transfer whose status is not `in_transit`"*. A GRN is not a
     * transfer and has no `in_transit` status; the code was BORROWED, which the same file forbids
     * in as many words ("it does not borrow a neighbouring code"). A client told `not_in_transit`
     * for a GRN awaiting QC cannot act on it — the remedy is *run gate QC*, and nothing in the
     * code said so.
     */
    throw new MaterialsError(
      "qc_not_run",
      `GRN ${grn.grnNo} has not been through gate QC — run it before posting`,
      { status: grn.status },
    );
  }

  const lines = await tx.select().from(grnLines).where(eq(grnLines.grnId, grnId)).orderBy(asc(grnLines.id));
  const acceptedLines = lines.filter((l) => l.qtyAcceptedBase > 0);
  const rejectedLines = lines.filter((l) => l.qtyAcceptedBase === 0);

  // ── A17: the approval's STATUS, never merely its presence ──
  if (acceptedLines.some((l) => l.nearExpiry)) {
    const approval = grn.approvalId === null ? null : await getApproval(tx as unknown as Db, grn.approvalId);
    if (approval === null || approval.status !== "granted") {
      throw new MaterialsError(
        "near_expiry_unapproved",
        `GRN ${grn.grnNo} carries a near-expiry line and needs a GRANTED ` +
          `${NEAR_EXPIRY_APPROVAL_TYPE} approval; its approval is "${approval?.status ?? "not requested"}"`,
        { approvalStatus: approval?.status ?? null },
      );
    }
  }

  // Nothing accepted: emit the rejections, close the GRN, write NO ledger row (T6's acceptance).
  if (acceptedLines.length === 0) {
    for (const l of rejectedLines) {
      await appendEvent(tx, grnLineRejected.make({
        payload: {
          grnId, grnLineId: l.id, itemId: l.itemId, rule: l.rejectReason ?? "unknown",
          qtyRejectedBase: l.qtyRejectedBase, batchNo: l.batchNo,
        },
        actor, correlationId: grnId,
      }));
    }
    await appendEvent(tx, grnRejected.make({
      payload: { grnId, grnNo: grn.grnNo, vendorId: grn.vendorId, rejectedLines: rejectedLines.length },
      actor, correlationId: grnId,
    }));
    await tx.update(grns).set({
      status: "posted", postedAt: now, updatedBy: actor.id, updatedAt: new Date(),
    }).where(eq(grns.id, grnId));
    return { status: "posted", ledgerEntryIds: [] };
  }

  const ownership = ownershipFor(grn.source);
  const movements: Parameters<typeof postMovements>[2] = [];
  const lots: { line: GrnLineRow; batchId: string }[] = [];

  for (const line of acceptedLines) {
    const batchId = await findOrCreateBatch(tx, actor, grn, line, ownership);
    /**
     * ═══ CLOSE REVIEW m4 — DD8 RULE 8 IS RE-ASKED AT POST, BECAUSE QC's ANSWER HAS AN AGE ═══
     *
     * `qcLine` rule 8 refuses a receipt into a recall-frozen batch, and it is evaluated in
     * `runGateQc` — a SEPARATE transaction, minutes or hours earlier. `recallBatch` can land in
     * between: it is one action, DD14 gives it to `materials_head`, and a recall is precisely the
     * event that happens between a delivery arriving and its paperwork being posted.
     *
     * What that produced, exactly: `recallBatch` sets `qty_frozen = qty_on_hand` **at the moment of
     * the freeze**, so a receipt posted afterwards raised `qty_on_hand` and left `qty_frozen`
     * behind. `available()` — `on_hand − reserved − frozen` — then reported the new stock as
     * available for a batch under recall. No stock could actually LEAVE (`postMovements` refuses
     * every outbound movement of a frozen batch, which is why this is a MINOR), but the recall
     * screen, `batchLocations` and 14c's leakage triangle would all have read a frozen batch as
     * partly free, and a recall is the one place a wrong number gets acted on urgently.
     *
     * Refusing the whole post is the safe direction AND a recoverable one: `runGateQc` accepts a
     * GRN in `accepted` / `partially_accepted` (its own status guard), so the storekeeper re-runs
     * gate QC, rule 8 rejects the affected line, and the rest of the delivery posts. Silently
     * receiving into a recalled batch is not recoverable at all.
     */
    const resolved = await getBatch(tx, batchId);
    if (resolved?.recallStatus === "frozen") {
      throw new MaterialsError(
        "batch_frozen",
        `batch ${resolved.batchNo} was recall-frozen after this GRN passed gate QC — re-run gate QC `
          + `before posting (DD8 rule 8, DD14)`,
        { grnLineId: line.id, batchId, batchNo: resolved.batchNo },
      );
    }
    await tx.update(grnLines).set({ batchId }).where(eq(grnLines.id, line.id));
    movements.push({
      resourceId: grn.storeResourceId, batchId, qtyDelta: line.qtyAcceptedBase,
      reason: "grn", refType: "grn", refId: grnId, occurredAt: new Date(`${grn.challanDate}T00:00:00Z`),
    });
    if (grn.source === "consignment_challan") lots.push({ line, batchId });
  }

  // ONE ordered lock over the whole GRN — a loop over `postMovement` would take one per line and
  // reintroduce exactly the interleave A9 is about.
  const posted = await postMovements(tx, actor, movements);

  for (const { line, batchId } of lots) {
    await createConsignmentLot(tx, actor, grn, line, batchId);
  }

  for (const l of rejectedLines) {
    await appendEvent(tx, grnLineRejected.make({
      payload: {
        grnId, grnLineId: l.id, itemId: l.itemId, rule: l.rejectReason ?? "unknown",
        qtyRejectedBase: l.qtyRejectedBase, batchNo: l.batchNo,
      },
      actor, correlationId: grnId,
    }));
  }
  await appendEvent(tx, grnReceived.make({
    payload: {
      grnId, grnNo: grn.grnNo, vendorId: grn.vendorId, storeResourceId: grn.storeResourceId,
      source: grn.source, challanNo: grn.challanNo, challanDate: grn.challanDate,
      acceptedLines: acceptedLines.length, rejectedLines: rejectedLines.length,
      approvalId: grn.approvalId,
    },
    actor, correlationId: grnId,
  }));

  await tx.update(grns).set({
    status: "posted", postedAt: now, updatedBy: actor.id, updatedAt: new Date(),
  }).where(eq(grns.id, grnId));
  return { status: "posted", ledgerEntryIds: posted.map((p) => p.ledgerEntryId) };
}

/**
 * **A14 — find-or-create on `(item, lower(batch_no), ownership)`, and REFUSE `batch_mismatch` when
 * the facts disagree.**
 *
 * The same physical batch arrives twice: once in March, once in June. It is ONE batch and one pile,
 * so the second receipt must REUSE the row — otherwise FEFO sees two batches with one expiry and
 * the recall freeze misses half the stock. **A post that always inserts** (A14's mutant) either
 * violates the unique index (a constraint name, not a code) or, if the key dropped `ownership`,
 * silently creates a second pile.
 *
 * And when the two receipts DISAGREE about the expiry or the MRP, one of them is wrong. There is no
 * safe automatic answer: taking the newer would let a mis-key overwrite a correct date, taking the
 * older would ignore a genuine correction. So it REFUSES and a human decides — which is what
 * `batch_mismatch` is for.
 */
async function findOrCreateBatch(
  tx: Tx,
  actor: Actor,
  grn: GrnRow,
  line: GrnLineRow,
  ownership: string,
): Promise<string> {
  const batchNo = (line.batchNo ?? "").trim();
  if (batchNo === "") {
    // A class exempt from rule 3 still needs a batch ROW to hang a balance on — the ledger is keyed
    // on `(resource, batch)` and has no "no batch" case. One is minted per GRN line, which is the
    // honest grain for stock nobody tracks by batch.
    const batchId = newId();
    await tx.insert(stockBatches).values({
      id: batchId, itemId: line.itemId, batchNo: `GRN-${grn.grnNo}-${line.id.slice(-6)}`,
      mfgDate: line.mfgDate, expiryDate: line.expiryDate,
      mrpPaise: line.mrpPaise, mrpUom: line.mrpUom,
      landedCostPaise: line.unitCostPaise, vendorId: grn.vendorId, grnLineId: line.id,
      ownership, createdBy: actor.id,
    });
    return batchId;
  }

  /**
   * ═══ CLOSE REVIEW m5 — **RECORDED, NOT FIXED**: a merged pile keeps the FIRST receipt's
   *     `landed_cost_paise`, and changing that is 14c's ruling to make, not this close pass's ═══
   *
   * A14 merges a second receipt of `(item, batch_no, ownership)` into the existing batch row when
   * expiry and MRP agree — deliberately, so one physical batch is one row. `landed_cost_paise` is
   * NOT re-examined, so a batch first received at ₹40 and topped up at ₹44 values the whole pile at
   * ₹40 for as long as it exists.
   *
   * **Left as it is, on purpose, and the reason is that every alternative is a COSTING POLICY:**
   * weighted average, FIFO layers, last-cost, or refusing the merge outright are four different
   * answers with four different sets of consequences for valuation, consumption and the P&L. DD18
   * fences this phase off from exactly that — no charge poster, no valuation, no Tally — and 14c
   * owns stock valuation. Picking one here would be inventing a rule nobody ruled, in the file
   * least likely to be read when the rule is finally written.
   *
   * What this phase can honestly say is what it costs: `landed_cost_paise` is a PURCHASE-PRICE
   * RECORD, not a valuation, and the only thing in this phase that reads it is QC rule 6's
   * below-cost check on the line's OWN `unit_cost_paise` — which is the line's, not the batch's. So
   * nothing here computes a wrong number today; a valuation built on this field later would.
   * **Carried to 14c as an open item rather than closed silently.**
   */
  const existing = await findBatch(tx, line.itemId, batchNo, ownership);
  if (existing !== undefined) {
    const expiryDiffers = (existing.expiryDate ?? null) !== (line.expiryDate ?? null);
    const mrpDiffers = (existing.mrpPaise ?? null) !== (line.mrpPaise ?? null)
      || (existing.mrpUom ?? null) !== (line.mrpUom ?? null);
    if (expiryDiffers || mrpDiffers) {
      throw new MaterialsError(
        "batch_mismatch",
        `batch ${batchNo} of this item already exists with ` +
          `expiry ${existing.expiryDate ?? "none"} and MRP ${String(existing.mrpPaise ?? "none")}; ` +
          `this challan says ${line.expiryDate ?? "none"} / ${String(line.mrpPaise ?? "none")}. ` +
          "One of them is wrong and a human must say which.",
        {
          batchNo,
          existing: { expiryDate: existing.expiryDate, mrpPaise: existing.mrpPaise, mrpUom: existing.mrpUom },
          incoming: { expiryDate: line.expiryDate, mrpPaise: line.mrpPaise, mrpUom: line.mrpUom },
        },
      );
    }
    return existing.id;
  }

  const batchId = newId();
  await tx.insert(stockBatches).values({
    id: batchId, itemId: line.itemId, batchNo,
    mfgDate: line.mfgDate, expiryDate: line.expiryDate,
    mrpPaise: line.mrpPaise, mrpUom: line.mrpUom,
    landedCostPaise: line.unitCostPaise, vendorId: grn.vendorId, grnLineId: line.id,
    ownership, createdBy: actor.id,
  });
  return batchId;
}

/**
 * The `consignment_lots` row, with **`deemed_supply_deadline = challan_date + 180 days`, COMPUTED
 * AT INSERT AND NEVER RECOMPUTED** (§31(7) of the CGST Act, DD5).
 *
 * The arithmetic is done on a UTC instant and read back as a calendar date, so it crosses month
 * boundaries and leap days without a special case — which is exactly what §2.93 says to verify in
 * the regime where the operands differ, and what T6's acceptance checks.
 *
 * `agreement_document_id` is NOT NULL and the FK is what makes O-8 structural: a consignment lot
 * cannot exist without the agreement it was received under.
 */
async function createConsignmentLot(
  tx: Tx,
  actor: Actor,
  grn: GrnRow,
  line: GrnLineRow,
  batchId: string,
): Promise<void> {
  /**
   * ═══ CLOSE REVIEW M9 — THE AGREEMENT MUST BE THE ONE IT WAS RECEIVED UNDER ═══
   *
   * This took `limit(1)` with no `ORDER BY` and no validity filter. QC rule 9 had proved that SOME
   * valid agreement exists; this then recorded an ARBITRARY one — and with an expired `CA/2023`
   * beside a current `CA/2026`, "arbitrary" is whichever the heap returns first, which can differ
   * between runs. The FK is described below as what makes O-8 structural; pointing it at an
   * agreement the goods were NOT received under is worse than not pointing it anywhere, because
   * 14c's reconciliation and any statutory audit will follow it in good faith.
   *
   * Now: filtered to those VALID ON THE CHALLAN DATE — the same predicate `hasValidDocument` uses,
   * so the gate and the record cannot disagree — and ordered so the choice is deterministic.
   *
   * ═══ SECOND-PASS FINDING F4 — `desc(validFrom)` IS **NULLS FIRST** IN POSTGRES, AND THAT PREFERS
   *     THE LEAST SPECIFIC AGREEMENT ═══
   *
   * The filter admits an open-ended agreement (`valid_from IS NULL`), exactly as `hasValidDocument`
   * does. Under a plain `ORDER BY valid_from DESC` Postgres sorts NULLs FIRST, so a document with
   * no start date at all outranks a specific, current, freshly-signed one. That is deterministic —
   * which is all M9 asked for — and it is deterministically the WRONG choice: "the agreement these
   * goods were received under" is the most specific one in force, not the vaguest.
   *
   * `NULLS LAST` makes dated agreements win and leaves the undated one as the fallback it is. The
   * same reasoning, and the same clause, as FEFO's `expiry_date asc NULLS LAST` in `ledger.ts`: a
   * row with no date is not the extreme of the range, it is outside it.
   */
  const docs = await tx.select().from(vendorDocuments)
    .where(and(
      eq(vendorDocuments.vendorId, grn.vendorId),
      eq(vendorDocuments.type, "consignment_agreement"),
      or(isNull(vendorDocuments.validFrom), sql`${vendorDocuments.validFrom} <= ${grn.challanDate}`),
      or(isNull(vendorDocuments.validTo), sql`${vendorDocuments.validTo} >= ${grn.challanDate}`),
    ))
    .orderBy(sql`${vendorDocuments.validFrom} desc nulls last`, desc(vendorDocuments.id))
    .limit(1);
  const agreementDocumentId = docs[0]?.id;
  if (agreementDocumentId === undefined) {
    // Unreachable through `postGrn` — rule 9 rejects the line first — and refused rather than
    // asserted, because a lot with no agreement is the exact thing O-8 forbids.
    throw new MaterialsError(
      "agreement_missing",
      `vendor has no consignment_agreement on file; a consignment lot cannot be created (O-8)`,
    );
  }
  const deadline = new Date(`${grn.challanDate}T00:00:00Z`);
  deadline.setUTCDate(deadline.getUTCDate() + DEEMED_SUPPLY_DAYS);

  await tx.insert(consignmentLots).values({
    id: newId(), vendorId: grn.vendorId, agreementDocumentId,
    challanNo: grn.challanNo, challanDate: grn.challanDate,
    itemId: line.itemId, batchId, storeResourceId: grn.storeResourceId,
    qtyReceived: line.qtyAcceptedBase, qtyDeployed: 0, qtyReturned: 0,
    deemedSupplyDeadline: deadline.toISOString().slice(0, 10),
    status: "open", createdBy: actor.id,
  });
}

// ═══════════════════════════════════════ READS ═══════════════════════════════════════

async function requireGrn(tx: Tx | Db, grnId: string): Promise<GrnRow> {
  const rows = await tx.select().from(grns).where(eq(grns.id, grnId));
  const row = rows[0];
  if (row === undefined) throw new MaterialsError("unknown_document", `GRN ${grnId} not found`);
  return row;
}

export async function getGrn(db: Db | Tx, grnId: string): Promise<GrnWithLines | undefined> {
  const rows = await db.select().from(grns).where(eq(grns.id, grnId));
  const row = rows[0];
  if (row === undefined) return undefined;
  const lines = await db.select().from(grnLines).where(eq(grnLines.grnId, grnId)).orderBy(asc(grnLines.id));
  return { ...row, lines };
}

export async function listGrns(
  db: Db | Tx,
  filter: { vendorId?: string; storeResourceId?: string; status?: string } = {},
): Promise<GrnRow[]> {
  const clauses = [];
  if (filter.vendorId !== undefined) clauses.push(eq(grns.vendorId, filter.vendorId));
  if (filter.storeResourceId !== undefined) clauses.push(eq(grns.storeResourceId, filter.storeResourceId));
  if (filter.status !== undefined) clauses.push(eq(grns.status, filter.status));
  const q = db.select().from(grns).orderBy(asc(grns.grnNo));
  return clauses.length === 0 ? q : q.where(and(...clauses));
}

/** The lots a batch backs. T7's consumption consumer reads it; 14c's reconciliation will too. */
export async function lotsForBatch(
  db: Db | Tx, batchId: string,
): Promise<(typeof consignmentLots.$inferSelect)[]> {
  return db.select().from(consignmentLots).where(eq(consignmentLots.batchId, batchId))
    .orderBy(asc(consignmentLots.challanDate));
}
