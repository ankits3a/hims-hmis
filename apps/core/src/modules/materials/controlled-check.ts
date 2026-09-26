import { and, asc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  controlledStockRegister, items, stockBalances, stockBatches, stockCountLines, stockCounts, stockLedger, users,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { fileCountAdjustment } from "./adjustments";
import { isControlledStore } from "./controlled";
import { MaterialsError } from "./errors";
import { stockCounted, stockVarianceFlagged } from "./events";
import { istDay } from "./grn";
import { requireStore } from "./stores";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P6 — THE CABINET'S REGISTER, ITS BALANCE, AND THE DAILY CHECK (brief 2026-09-26, §3, §5) ═══
 *
 *   - `controlledRegisterRows`: the register as written (`controlled.ts` writes it inside `postMovements`),
 *     filtered to one statutory register — `ndps` (Form 3H: the rows with an NDPS class) or `x` (D&C Rules
 *     r.65(21): the Schedule X rows) — or all of it.
 *   - `controlledBalance`: per drug per batch over a range, opening + received − issued − destroyed ±
 *     adjusted = closing, from the REGISTER, set beside the closing the STOCK LEDGER holds and the count of
 *     rows each holds. `reconciled` is the identity; a row that fails it is a movement the register did not
 *     see, which the design says cannot happen — so a red row here is an incident, not a rounding.
 *   - `recordControlledCheck`: the day's balance check — the holder and a witness count every batch in the
 *     cabinet (Form 3H is "completed for each day before the close of the day"). It is a `stock_counts`
 *     row of kind `controlled_check`; a batch that does not balance files the `materials_stock_adjustment`
 *     request to the medical superintendent at once, the path a cycle count's variance takes.
 */

/** The instant an IST calendar day begins. */
function istDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000+05:30`);
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function requireControlledStore(db: Db | Tx, storeResourceId: string) {
  const store = await requireStore(db, storeResourceId);
  if (!isControlledStore(store)) {
    throw new MaterialsError("controlled_check_invalid", `${store.name} (${store.code}) is not the controlled-drug cabinet`, { storeResourceId });
  }
  return store;
}

export type ControlledRegister = "ndps" | "x" | "all";

export type ControlledRegisterRow = {
  seq: number; id: string; ledgerEntryId: string; storeResourceId: string; itemId: string; batchId: string; medicineId: string | null;
  drugName: string; batchNo: string; expiryDate: string | null; ndpsClass: string | null; scheduleFlag: string | null;
  movement: string; direction: "in" | "out"; qtyBase: number; unit: string; balanceAfter: number; occurredAt: string;
  holderId: string; holderName: string; holderRegNo: string | null; witnessId: string; witnessName: string;
  extraWitnesses: { userId: string | null; name: string; role: string }[];
  counterparty: string | null; counterpartyAddress: string | null; counterpartyLicence: string | null;
  documentRef: string | null; documentDate: string | null; rxRef: string | null;
  patientId: string | null; prescriberName: string | null; prescriberRegNo: string | null;
  retainedDocumentId: string | null; collectedBy: string | null; collectedIdProof: string | null; note: string | null;
};

type RegisterDbRow = typeof controlledStockRegister.$inferSelect;
function rowView(r: RegisterDbRow): ControlledRegisterRow {
  return {
    seq: r.seq, id: r.id, ledgerEntryId: r.ledgerEntryId, storeResourceId: r.storeResourceId, itemId: r.itemId, batchId: r.batchId,
    medicineId: r.medicineId, drugName: r.drugName, batchNo: r.batchNo, expiryDate: r.expiryDate, ndpsClass: r.ndpsClass,
    scheduleFlag: r.scheduleFlag, movement: r.movement, direction: r.direction as "in" | "out", qtyBase: r.qtyBase, unit: r.unit,
    balanceAfter: r.balanceAfter, occurredAt: r.occurredAt.toISOString(), holderId: r.holderId, holderName: r.holderName,
    holderRegNo: r.holderRegNo, witnessId: r.witnessId, witnessName: r.witnessName, extraWitnesses: r.extraWitnesses,
    counterparty: r.counterparty, counterpartyAddress: r.counterpartyAddress, counterpartyLicence: r.counterpartyLicence,
    documentRef: r.documentRef, documentDate: r.documentDate, rxRef: r.rxRef, patientId: r.patientId, prescriberName: r.prescriberName,
    prescriberRegNo: r.prescriberRegNo, retainedDocumentId: r.retainedDocumentId, collectedBy: r.collectedBy,
    collectedIdProof: r.collectedIdProof, note: r.note,
  };
}

function registerFilter(register: ControlledRegister) {
  if (register === "ndps") return sql`${controlledStockRegister.ndpsClass} is not null`;
  if (register === "x") return sql`${controlledStockRegister.scheduleFlag} = 'X'`;
  return sql`true`;
}

/** The register's rows in a range of IST days, oldest first (the order they were written). At most 5,000. */
export async function controlledRegisterRows(
  db: Db | Tx,
  filter: { storeResourceId?: string; fromDay: string; toDay: string; register: ControlledRegister; itemId?: string; patientId?: string },
): Promise<ControlledRegisterRow[]> {
  const rows = await db.select().from(controlledStockRegister).where(and(
    gte(controlledStockRegister.occurredAt, istDayStart(filter.fromDay)),
    lt(controlledStockRegister.occurredAt, istDayStart(nextDay(filter.toDay))),
    registerFilter(filter.register),
    ...(filter.storeResourceId === undefined ? [] : [eq(controlledStockRegister.storeResourceId, filter.storeResourceId)]),
    ...(filter.itemId === undefined ? [] : [eq(controlledStockRegister.itemId, filter.itemId)]),
    ...(filter.patientId === undefined ? [] : [eq(controlledStockRegister.patientId, filter.patientId)]),
  )).orderBy(asc(controlledStockRegister.seq)).limit(5000);
  return rows.map(rowView);
}

export type ControlledBalanceRow = {
  itemId: string; drugName: string; unit: string; batchId: string; batchNo: string; expiryDate: string | null;
  ndpsClass: string | null; scheduleFlag: string | null;
  opening: number; received: number; issued: number; destroyed: number; adjusted: number; closing: number;
  /** What the stock ledger holds for the batch in the cabinet at the end of the range. */
  ledgerClosing: number;
  registerRows: number; ledgerRows: number;
  reconciled: boolean;
};
export type ControlledBalance = { storeResourceId: string; fromDay: string; toDay: string; rows: ControlledBalanceRow[]; reconciled: boolean };

/**
 * Received = `grn` and `receive` in (and a return INTO the cabinet); issued = `consume`, `issue` and a
 * return to the supplier; destroyed = an `adjust` out of a write-off; adjusted = any other `adjust`, signed
 * (the MS-approved variance of a balance check). The category comes from the ledger row's `ref_type`, read
 * through the register's own `ledger_entry_id`.
 */
export async function controlledBalance(db: Db | Tx, input: { storeResourceId: string; fromDay: string; toDay: string }): Promise<ControlledBalance> {
  await requireControlledStore(db, input.storeResourceId);
  const from = istDayStart(input.fromDay);
  const end = istDayStart(nextDay(input.toDay));
  const reg = await db.select({
    batchId: controlledStockRegister.batchId, itemId: controlledStockRegister.itemId, drugName: controlledStockRegister.drugName,
    unit: controlledStockRegister.unit, batchNo: controlledStockRegister.batchNo, expiryDate: controlledStockRegister.expiryDate,
    ndpsClass: controlledStockRegister.ndpsClass, scheduleFlag: controlledStockRegister.scheduleFlag,
    movement: controlledStockRegister.movement, direction: controlledStockRegister.direction, qty: controlledStockRegister.qtyBase,
    occurredAt: controlledStockRegister.occurredAt, refType: stockLedger.refType,
  }).from(controlledStockRegister)
    .innerJoin(stockLedger, eq(stockLedger.id, controlledStockRegister.ledgerEntryId))
    .where(and(eq(controlledStockRegister.storeResourceId, input.storeResourceId), lt(controlledStockRegister.occurredAt, end)))
    .orderBy(asc(controlledStockRegister.seq));
  const ledger = await db.select({
    batchId: stockLedger.batchId,
    closing: sql<string>`coalesce(sum(${stockLedger.qtyDelta}), 0)`,
    rows: sql<string>`count(*) filter (where ${stockLedger.occurredAt} >= ${from})`,
  }).from(stockLedger)
    .where(and(eq(stockLedger.resourceId, input.storeResourceId), lt(stockLedger.occurredAt, end)))
    .groupBy(stockLedger.batchId);
  const ledgerBy = new Map(ledger.map((l) => [l.batchId, { closing: Number(l.closing), rows: Number(l.rows) }]));

  const rows = new Map<string, ControlledBalanceRow>();
  for (const r of reg) {
    const row = rows.get(r.batchId) ?? {
      itemId: r.itemId, drugName: r.drugName, unit: r.unit, batchId: r.batchId, batchNo: r.batchNo, expiryDate: r.expiryDate,
      ndpsClass: r.ndpsClass, scheduleFlag: r.scheduleFlag,
      opening: 0, received: 0, issued: 0, destroyed: 0, adjusted: 0, closing: 0, ledgerClosing: 0, registerRows: 0, ledgerRows: 0, reconciled: false,
    };
    const signed = r.direction === "in" ? r.qty : -r.qty;
    if (r.occurredAt < from) {
      row.opening += signed;
    } else {
      row.registerRows += 1;
      if (r.movement === "adjust") {
        if (r.refType === "stock_write_off" && r.direction === "out") row.destroyed += r.qty;
        else row.adjusted += signed;
      } else if (r.direction === "in") {
        row.received += r.qty;
      } else {
        row.issued += r.qty;
      }
    }
    rows.set(r.batchId, row);
  }
  // A batch the ledger moved in the cabinet with no register row at all is shown too — it can only be a gap.
  const missing = [...ledgerBy.keys()].filter((b) => !rows.has(b));
  if (missing.length > 0) {
    const facts = await db.select({
      batchId: stockBatches.id, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate,
      itemId: items.id, drugName: items.name, unit: items.baseUom,
    }).from(stockBatches).innerJoin(items, eq(items.id, stockBatches.itemId)).where(inArray(stockBatches.id, missing));
    for (const f of facts) {
      rows.set(f.batchId, {
        itemId: f.itemId, drugName: f.drugName, unit: f.unit, batchId: f.batchId, batchNo: f.batchNo, expiryDate: f.expiryDate,
        ndpsClass: null, scheduleFlag: null,
        opening: 0, received: 0, issued: 0, destroyed: 0, adjusted: 0, closing: 0, ledgerClosing: 0, registerRows: 0, ledgerRows: 0, reconciled: false,
      });
    }
  }
  for (const row of rows.values()) {
    row.closing = row.opening + row.received - row.issued - row.destroyed + row.adjusted;
    const l = ledgerBy.get(row.batchId) ?? { closing: 0, rows: 0 };
    row.ledgerClosing = l.closing;
    row.ledgerRows = l.rows;
    row.reconciled = row.closing === row.ledgerClosing && row.registerRows === row.ledgerRows;
  }
  const out = [...rows.values()]
    .filter((r) => r.opening !== 0 || r.registerRows > 0 || r.ledgerRows > 0 || r.ledgerClosing !== 0)
    .sort((a, b) => a.drugName.localeCompare(b.drugName) || a.batchNo.localeCompare(b.batchNo));
  return { storeResourceId: input.storeResourceId, fromDay: input.fromDay, toDay: input.toDay, rows: out, reconciled: out.every((r) => r.reconciled) };
}

export type ControlledSheetLine = {
  batchId: string; itemId: string; drugName: string; batchNo: string; expiryDate: string | null; unit: string; onHand: number; reserved: number;
};

/** What the day's check counts: every batch the cabinet holds (reserved stock is on the shelf too, counted with it). */
export async function controlledCheckSheet(db: Db | Tx, storeResourceId: string): Promise<ControlledSheetLine[]> {
  await requireControlledStore(db, storeResourceId);
  const rows = await db.select({
    batchId: stockBalances.batchId, itemId: stockBalances.itemId, onHand: stockBalances.qtyOnHand, reserved: stockBalances.qtyReserved,
    drugName: items.name, unit: items.baseUom, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate,
  }).from(stockBalances)
    .innerJoin(items, eq(items.id, stockBalances.itemId))
    .innerJoin(stockBatches, eq(stockBatches.id, stockBalances.batchId))
    .where(and(eq(stockBalances.resourceId, storeResourceId), gt(stockBalances.qtyOnHand, 0)))
    .orderBy(asc(items.name), asc(stockBatches.batchNo));
  return rows;
}

export type ControlledCheckResult = {
  countId: string; storeResourceId: string; checkedAt: string; checkedBy: string; witnessedBy: string;
  lines: { batchId: string; drugName: string; batchNo: string; expected: number; counted: number; variance: number }[];
  balanced: boolean; approvalId: string | null;
};

/**
 * The day's check. The holder (`actor`) and the witness count; `lines` must name every batch the cabinet
 * holds, once. Balanced → the count is closed. Not balanced → it is submitted and the variance goes to the
 * medical superintendent (`fileCountAdjustment`: shrinkage for a shortfall, found for an excess), with the
 * note saying the cabinet did not balance.
 */
export async function recordControlledCheck(
  db: Db, actor: Actor,
  input: { storeResourceId: string; witnessId: string; lines: readonly { batchId: string; countedQty: number }[]; note?: string | null },
  now: Date,
): Promise<ControlledCheckResult> {
  const store = await requireControlledStore(db, input.storeResourceId);
  if (actor.type !== "user") throw new MaterialsError("custody_required", "only a person checks the controlled-drug cabinet");
  if (input.witnessId === actor.id) throw new MaterialsError("custody_same_person", "the witness to the balance check is somebody other than its holder");
  const [witness] = await db.select({ id: users.id, active: users.active }).from(users).where(eq(users.id, input.witnessId));
  if (witness === undefined || !witness.active) throw new MaterialsError("custody_witness_unknown", "the witness is not an active member of staff", { userId: input.witnessId });

  return withTx(db, async (tx) => {
    const sheet = await tx.select({
      batchId: stockBalances.batchId, itemId: stockBalances.itemId, onHand: stockBalances.qtyOnHand,
      drugName: items.name, batchNo: stockBatches.batchNo, landed: stockBatches.landedCostPaise,
    }).from(stockBalances)
      .innerJoin(items, eq(items.id, stockBalances.itemId))
      .innerJoin(stockBatches, eq(stockBatches.id, stockBalances.batchId))
      .where(eq(stockBalances.resourceId, store.id))
      .for("update", { of: stockBalances });
    const byBatch = new Map(sheet.map((s) => [s.batchId, s]));
    const given = new Map<string, number>();
    for (const l of input.lines) {
      if (!Number.isSafeInteger(l.countedQty) || l.countedQty < 0) {
        throw new MaterialsError("controlled_check_invalid", "a count is a whole number, zero or more", { batchId: l.batchId });
      }
      if (!byBatch.has(l.batchId)) throw new MaterialsError("controlled_check_invalid", `batch ${l.batchId} was never in ${store.code}`, { batchId: l.batchId });
      if (given.has(l.batchId)) throw new MaterialsError("controlled_check_invalid", "a batch is counted once", { batchId: l.batchId });
      given.set(l.batchId, l.countedQty);
    }
    const unCounted = sheet.filter((s) => s.onHand > 0 && !given.has(s.batchId));
    if (unCounted.length > 0) {
      throw new MaterialsError(
        "controlled_check_invalid",
        `every batch in the cabinet is counted — ${unCounted.map((u) => `${u.drugName} ${u.batchNo}`).join(", ")} ${unCounted.length === 1 ? "is" : "are"} missing`,
        { missing: unCounted.map((u) => u.batchId) },
      );
    }
    const lines = [...given.entries()].map(([batchId, counted]) => {
      const s = byBatch.get(batchId)!;
      return { batchId, itemId: s.itemId, drugName: s.drugName, batchNo: s.batchNo, expected: s.onHand, counted, variance: counted - s.onHand, landed: s.landed };
    });
    const variances = lines.filter((l) => l.variance !== 0);
    const balanced = variances.length === 0;
    const countId = newId();
    const note = input.note?.trim() ?? "";
    await tx.insert(stockCounts).values({
      id: countId, resourceId: store.id, kind: "controlled_check", status: balanced ? "closed" : "submitted",
      scheduledBy: actor.id, counterUserId: input.witnessId, frozenAt: now, countedAt: now, submittedAt: now,
      ...(balanced ? { closedBy: actor.id, closedAt: now, closeNote: note === "" ? "balanced" : note } : {}),
    });
    const lineIds = new Map<string, string>();
    if (lines.length > 0) {
      await tx.insert(stockCountLines).values(lines.map((l) => {
        const id = newId();
        lineIds.set(l.batchId, id);
        return {
          id, countId, batchId: l.batchId, itemId: l.itemId, systemQty: l.expected, countedQty: l.counted, movedQty: 0,
          varianceQty: l.variance, variancePaise: l.variance * l.landed, flag: l.variance === 0 ? "match" : "variance",
        };
      }));
    }
    for (const v of variances) {
      await appendEvent(tx, stockVarianceFlagged.make({
        occurredAt: now, actor,
        payload: {
          countId, storeResourceId: store.id, batchId: v.batchId, itemId: v.itemId, systemQty: v.expected, movedQty: 0,
          countedQty: v.counted, varianceQty: v.variance, variancePaise: v.variance * v.landed, recount: false,
        },
      }));
    }
    await appendEvent(tx, stockCounted.make({
      occurredAt: now, actor,
      payload: {
        countId, storeResourceId: store.id, countedBy: actor.id, countedAt: now.toISOString(), lines: lines.length,
        matched: lines.length - variances.length, variances: variances.length, recounts: 0,
        netVariancePaise: variances.reduce((s, v) => s + v.variance * v.landed, 0), recountId: null,
      },
    }));
    const approvalId = balanced ? null : await fileCountAdjustment(tx, actor, {
      countId, resourceId: store.id,
      planned: variances.map((v) => ({
        lineId: lineIds.get(v.batchId)!, batchId: v.batchId, itemId: v.itemId, qtyDelta: v.variance, valuePaise: v.variance * v.landed,
        reasonCode: v.variance < 0 ? "shrinkage" as const : "found" as const,
      })),
      note: `controlled cabinet ${store.code} did not balance on ${istDay(now)}: ${variances.map((v) => `${v.drugName} ${v.batchNo} ${v.variance > 0 ? "+" : ""}${String(v.variance)}`).join("; ")} — investigate before it is booked${note === "" ? "" : ` — ${note}`}`,
    }, now);
    return {
      countId, storeResourceId: store.id, checkedAt: now.toISOString(), checkedBy: actor.id, witnessedBy: input.witnessId,
      lines: lines.map(({ batchId, drugName, batchNo, expected, counted, variance }) => ({ batchId, drugName, batchNo, expected, counted, variance })),
      balanced, approvalId,
    };
  });
}

export type ControlledCheckSummary = { countId: string; checkedAt: string; checkedBy: string; witnessedBy: string; balanced: boolean; status: string };

/** The cabinet's checks recorded on an IST day, newest first. */
export async function controlledChecksOn(db: Db | Tx, storeResourceId: string, day: string): Promise<ControlledCheckSummary[]> {
  const rows = await db.select().from(stockCounts).where(and(
    eq(stockCounts.resourceId, storeResourceId), eq(stockCounts.kind, "controlled_check"),
    gte(stockCounts.frozenAt, istDayStart(day)), lt(stockCounts.frozenAt, istDayStart(nextDay(day))),
  )).orderBy(sql`${stockCounts.frozenAt} desc`);
  return rows.map((r) => ({
    countId: r.id, checkedAt: r.frozenAt.toISOString(), checkedBy: r.scheduledBy, witnessedBy: r.counterUserId,
    balanced: r.status === "closed", status: r.status,
  }));
}

/** Balance checks that did not balance and whose variance is not yet booked or refused — the office's discrepancies. */
export async function openControlledDiscrepancies(db: Db | Tx, storeResourceId: string): Promise<{ countId: string; checkedAt: string }[]> {
  const rows = await db.select({ id: stockCounts.id, at: stockCounts.frozenAt }).from(stockCounts).where(and(
    eq(stockCounts.resourceId, storeResourceId), eq(stockCounts.kind, "controlled_check"), eq(stockCounts.status, "submitted"),
    sql`exists (select 1 from stock_adjustments a where a.count_id = ${stockCounts.id} and a.status = 'requested')`,
  )).orderBy(asc(stockCounts.frozenAt));
  return rows.map((r) => ({ countId: r.id, checkedAt: r.at.toISOString() }));
}

/**
 * A balance check's variance the medical superintendent has DECIDED and nobody has booked: granted ones
 * wait for the holder and a witness to post them (`postAdjustments` with custody), rejected ones are
 * settled as refused on the next post attempt. One row per approval.
 */
export async function controlledAdjustmentsToBook(db: Db | Tx, storeResourceId: string): Promise<{ approvalId: string; countId: string; lines: number; netQty: number }[]> {
  const rows = await db.execute(sql`
    select a.approval_id as "approvalId", a.count_id as "countId", count(*)::int as "lines", sum(a.qty_delta)::int as "netQty"
    from stock_adjustments a
    join stock_counts c on c.id = a.count_id
    join approvals ap on ap.id = a.approval_id
    where c.resource_id = ${storeResourceId} and c.kind = 'controlled_check' and a.status = 'requested' and ap.status = 'granted'
    group by a.approval_id, a.count_id
    order by min(a.requested_at)`);
  return (rows.rows as { approvalId: string; countId: string; lines: number; netQty: number }[]);
}
