import { and, asc, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  COLD_EXCURSION_DECISIONS, COLD_STORAGE_CLASS,
  items, pharmacyColdExcursionBatches, pharmacyColdExcursionCloses, pharmacyColdExcursionDecisions, pharmacyColdExcursions,
  pharmacyColdReadings, pharmacyColdUnits, resources, stockBalances, stockBatches, users,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { listStores, raiseWriteOff, requireStore } from "../materials";
import { istDateOf, istInstantOf } from "./config";
import { PharmacyError } from "./errors";
import { coldExcursionClosed, coldReadingRecorded, coldUnitSaved } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { ColdExcursionDecision } from "../../kernel/db/schema";

/**
 * ═══ PHARMACY STAGE D3 — THE FRIDGE TEMPERATURE LOG AND THE EXCURSION HOLD ═══
 *
 * Basis: Drugs & Cosmetics Rules 1945 (store as the label directs) and NABH MOM (the cold chain is monitored
 * and documented). Phase doc `docs/superpowers/plans/2026-09-28-pharmacy-safety-stage-d.md`, D3.
 *
 * - A FRIDGE (`pharmacy_cold_units`) sits in a store and holds a range, 2.0–8.0 °C unless the in-charge says
 *   otherwise. It is a master row, edited in place under `pharmacy.coldchain.manage`, every save an audit event
 *   carrying the before and the after (`coldchain.unit_saved`).
 * - A READING (`pharmacy_cold_readings`, append-only) is the min/max thermometer read at the door: now, and the
 *   lowest and highest since the last reset. Any of the three outside the range OPENS AN EXCURSION in the
 *   reading's own transaction — at most one open per fridge — and FREEZES its list of held batches: every batch
 *   of a `cold_2_8` item with stock on hand in that store at that instant.
 * - THE HOLD. While an excursion is open, a held batch does not leave: `handOverDispense` and the walk-in sale
 *   refuse it with `cold_chain_excursion_open`, naming the fridge and saying to call the pharmacy in-charge.
 * - THE CLOSE (`pharmacy.coldchain.manage`) decides every held batch: `release` (inside the product's stability
 *   data, the reason written down) or `write_off` (a materials destruction write-off, reason `damage`, raised in
 *   the same transaction; the MS approves it like any other). A batch decided `write_off` STAYS held at that
 *   store after the close — a heat-damaged vial never goes back on sale because the write-off is still waiting
 *   for its approval, or was refused.
 * - THE SCHEDULE (DECIDED): readings at 09:00 and 17:00 IST. A slot is met by a reading taken from 30 minutes
 *   before it to 60 minutes after it; a slot 60 minutes past with no reading is MISSED. Computed when read — no
 *   worker job.
 */
export const COLDCHAIN_RECORD_PERMISSION = "pharmacy.coldchain.record";
export const COLDCHAIN_MANAGE_PERMISSION = "pharmacy.coldchain.manage";
/** DECIDED — the two daily readings, IST wall-clock. */
export const COLD_SLOTS_IST = ["09:00", "17:00"] as const;
/** A slot with no reading this many minutes after it is missed. */
export const COLD_SLOT_GRACE_MINUTES = 60;
/** A reading this many minutes early still meets the slot. */
export const COLD_SLOT_EARLY_MINUTES = 30;
/** A reading may be entered this long after it was taken (the paper chart during an outage); never from the future. */
export const COLD_READING_BACKDATE_HOURS = 24;
const LIST_LIMIT = 200;
const MAX_TEXT = 1000;
const MINUTE = 60_000;

export const excursionNumber = (seq: number): string => `CE-${String(seq).padStart(6, "0")}`;

export type ColdSlotState = "done" | "due" | "missed" | "upcoming" | "not_due";
export type ColdSlot = { slot: string; state: ColdSlotState; readingId: string | null };

export type ColdReadingView = {
  id: string; unitId: string; currentC: string; minC: string; maxC: string; outOfRange: boolean;
  takenAt: string; takenByName: string | null; note: string | null;
};

export type ColdExcursionSummary = { id: string; no: string; openedAt: string; batches: number };

export type ColdUnitView = {
  id: string; label: string; lowC: string; highC: string; active: boolean;
  store: { id: string; code: string; name: string };
  slots: ColdSlot[];
  lastReading: ColdReadingView | null;
  openExcursion: ColdExcursionSummary | null;
};

export type ColdExcursionBatchView = {
  batchId: string; batchNo: string; expiryDate: string | null; itemId: string; itemName: string; qtyOnHand: number;
  decision: { decision: ColdExcursionDecision; reason: string | null; writeOffId: string | null; decidedAt: string } | null;
};

export type ColdExcursionView = {
  id: string; no: string; unit: { id: string; label: string }; store: { id: string; code: string; name: string };
  lowC: string; highC: string; openedAt: string;
  reading: { id: string; currentC: string; minC: string; maxC: string; takenAt: string };
  batches: ColdExcursionBatchView[];
  closed: { closedAt: string; closedByName: string | null; note: string | null } | null;
};

function bad(message: string, detail?: Record<string, unknown>): never {
  throw new PharmacyError("invalid_cold_chain", message, detail);
}

const clean = (v: string | null | undefined): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t === "" ? null : t.slice(0, MAX_TEXT);
};

/** A temperature to one decimal place, as the column stores it; anything else is refused, not rounded. */
function celsius(v: unknown, what: string): string {
  if (typeof v !== "number" || !Number.isFinite(v)) bad(`${what} is not a temperature`);
  if (Math.abs(v * 10 - Math.round(v * 10)) > 1e-6) bad(`${what} is read to one decimal place (${String(v)})`);
  if (v < -50 || v > 60) bad(`${what} ${String(v)} °C is not a fridge reading — check the thermometer`);
  return v.toFixed(1);
}

const outside = (c: number, low: number, high: number): boolean => c < low || c > high;

async function hasAny(db: Db | Tx, actor: Actor, perms: readonly string[]): Promise<boolean> {
  if (actor.type !== "user") return false;
  for (const p of perms) if (await hasPermission(db as Db, actor.id, p, "hospital")) return true;
  return false;
}

async function requirePerm(db: Db | Tx, actor: Actor, perm: string, what: string): Promise<string> {
  if (actor.type !== "user" || !(await hasPermission(db as Db, actor.id, perm, "hospital"))) {
    throw new PharmacyError("permission_denied", `${what} needs ${perm}`);
  }
  return actor.id;
}

/** The log is read by whoever records it or manages it (the D1 register's shape). */
export async function assertColdReader(db: Db | Tx, actor: Actor): Promise<void> {
  if (!(await hasAny(db, actor, [COLDCHAIN_RECORD_PERMISSION, COLDCHAIN_MANAGE_PERMISSION]))) {
    throw new PharmacyError("permission_denied", `the fridge log is read with ${COLDCHAIN_RECORD_PERMISSION} or ${COLDCHAIN_MANAGE_PERMISSION}`);
  }
}

// ═══════════════════════════════════ the fridges ═══════════════════════════════════

export type SaveColdUnitInput = {
  /** Absent: a new fridge. */
  id?: string;
  /** A new fridge's store; a fridge never moves store (a fridge moved is a new fridge). */
  storeResourceId?: string;
  label: string;
  lowC?: number;
  highC?: number;
  active?: boolean;
};

/**
 * Add or edit a fridge. DECIDED: a mutable master row with an audit event per save (the before and the
 * after), not a versioned table — the range a reading was judged against is copied onto its excursion, so
 * nothing that was decided under the old range is rewritten by the new one.
 */
export async function saveColdUnit(db: Db, actor: Actor, input: SaveColdUnitInput, now: Date = new Date()): Promise<{ unitId: string }> {
  const userId = await requirePerm(db, actor, COLDCHAIN_MANAGE_PERMISSION, "adding or editing a fridge");
  const label = clean(input.label);
  if (label === null) bad("name the fridge (as it is labelled on the door)");
  return withTx(db, async (tx) => {
    let before: { label: string; lowC: string; highC: string; active: boolean } | null = null;
    let unitId: string;
    let storeResourceId: string;
    if (input.id === undefined) {
      if (input.storeResourceId === undefined) bad("a new fridge names its store");
      storeResourceId = (await requireStore(tx, input.storeResourceId)).id;
      unitId = newId();
    } else {
      const [row] = await tx.select().from(pharmacyColdUnits).where(eq(pharmacyColdUnits.id, input.id)).for("update");
      if (row === undefined) throw new PharmacyError("unknown_cold_unit", `fridge ${input.id} not found`);
      if (input.storeResourceId !== undefined && input.storeResourceId !== row.storeResourceId) bad("a fridge does not move store — add the new place as a new fridge and set this one inactive");
      before = { label: row.label, lowC: row.lowC, highC: row.highC, active: row.active };
      unitId = row.id;
      storeResourceId = row.storeResourceId;
    }
    const lowC = input.lowC === undefined ? (before?.lowC ?? "2.0") : celsius(input.lowC, "the lowest allowed");
    const highC = input.highC === undefined ? (before?.highC ?? "8.0") : celsius(input.highC, "the highest allowed");
    if (Number(lowC) >= Number(highC)) bad(`the range ${lowC}–${highC} °C is empty: the low end is below the high end`);
    const active = input.active ?? before?.active ?? true;
    const [clash] = await tx.select({ id: pharmacyColdUnits.id }).from(pharmacyColdUnits)
      .where(and(eq(pharmacyColdUnits.storeResourceId, storeResourceId), sql`lower(${pharmacyColdUnits.label}) = ${label.toLowerCase()}`));
    if (clash !== undefined && clash.id !== unitId) bad(`this store already has a fridge called "${label}"`);
    if (before === null) {
      await tx.insert(pharmacyColdUnits).values({ id: unitId, storeResourceId, label, lowC, highC, active, createdBy: userId, createdAt: now });
    } else {
      await tx.update(pharmacyColdUnits).set({ label, lowC, highC, active, updatedBy: userId, updatedAt: now }).where(eq(pharmacyColdUnits.id, unitId));
    }
    await appendEvent(tx, coldUnitSaved.make({
      actor, occurredAt: now, payload: { unitId, storeResourceId, before, after: { label, lowC, highC, active } },
    }));
    return { unitId };
  });
}

/** The stores a fridge may be put in (the manage sheet's picker). */
export async function coldChainStores(db: Db, actor: Actor): Promise<{ id: string; code: string; name: string }[]> {
  await requirePerm(db, actor, COLDCHAIN_MANAGE_PERMISSION, "choosing a fridge's store");
  return (await listStores(db)).map((s) => ({ id: s.id, code: s.code, name: s.name }));
}

// ═══════════════════════════════════ the reading, and the excursion it may open ═══════════════════════════════════

export type RecordColdReadingInput = {
  unitId: string; currentC: number; minC: number; maxC: number; takenAt?: Date | null; note?: string | null;
};

export type RecordedColdReading = {
  readingId: string; outOfRange: boolean;
  /** The excursion this reading opened; null when in range, or when one was already open on the fridge. */
  opened: ColdExcursionSummary | null;
};

/**
 * Record a reading. Out of range and no excursion open on this fridge: open one in this transaction and
 * freeze the held batches. The fridge's row is locked first, so two readings at one fridge are serialised
 * and the partial unique index (one open per fridge) is never the thing that answers.
 */
export async function recordColdReading(db: Db, actor: Actor, input: RecordColdReadingInput, now: Date = new Date()): Promise<RecordedColdReading> {
  const userId = await requirePerm(db, actor, COLDCHAIN_RECORD_PERMISSION, "recording a fridge reading");
  const currentC = celsius(input.currentC, "the current temperature");
  const minC = celsius(input.minC, "the minimum");
  const maxC = celsius(input.maxC, "the maximum");
  if (!(Number(minC) <= Number(currentC) && Number(currentC) <= Number(maxC))) {
    bad(`the minimum (${minC}), current (${currentC}) and maximum (${maxC}) must read low to high — check which is which on the thermometer`);
  }
  const takenAt = input.takenAt ?? now;
  if (Number.isNaN(takenAt.getTime()) || takenAt.getTime() > now.getTime() + MINUTE) bad("the reading's time is in the future");
  if (now.getTime() - takenAt.getTime() > COLD_READING_BACKDATE_HOURS * 60 * MINUTE) {
    bad(`a reading is entered within ${String(COLD_READING_BACKDATE_HOURS)} hours of taking it — note an older one on a new reading instead`);
  }
  const note = clean(input.note);

  return withTx(db, async (tx) => {
    const [unit] = await tx.select().from(pharmacyColdUnits).where(eq(pharmacyColdUnits.id, input.unitId)).for("update");
    if (unit === undefined) throw new PharmacyError("unknown_cold_unit", `fridge ${input.unitId} not found`);
    if (!unit.active) bad(`fridge "${unit.label}" is inactive — the in-charge sets it active again before it is read`);
    const low = Number(unit.lowC);
    const high = Number(unit.highC);
    const outOfRange = [currentC, minC, maxC].some((c) => outside(Number(c), low, high));
    const readingId = newId();
    await tx.insert(pharmacyColdReadings).values({ id: readingId, unitId: unit.id, currentC, minC, maxC, takenAt, takenBy: userId, note, recordedAt: now });

    let opened: ColdExcursionSummary | null = null;
    if (outOfRange) {
      const [already] = await tx.select({ id: pharmacyColdExcursions.id }).from(pharmacyColdExcursions)
        .where(and(eq(pharmacyColdExcursions.unitId, unit.id), isNull(pharmacyColdExcursions.closedAt)));
      if (already === undefined) {
        const excursionId = newId();
        const [row] = await tx.insert(pharmacyColdExcursions).values({
          id: excursionId, unitId: unit.id, storeResourceId: unit.storeResourceId, readingId, lowC: unit.lowC, highC: unit.highC, openedAt: takenAt,
        }).returning({ seq: pharmacyColdExcursions.seq });
        /* The held list, FROZEN now: every cold_2_8 batch with stock on hand in this store at this instant. */
        const held = await tx.select({ batchId: stockBalances.batchId, itemId: stockBalances.itemId, qty: stockBalances.qtyOnHand })
          .from(stockBalances).innerJoin(items, eq(items.id, stockBalances.itemId))
          .where(and(eq(stockBalances.resourceId, unit.storeResourceId), gt(stockBalances.qtyOnHand, 0), eq(items.storageClass, COLD_STORAGE_CLASS)));
        if (held.length > 0) {
          await tx.insert(pharmacyColdExcursionBatches).values(held.map((h) => ({ excursionId, batchId: h.batchId, itemId: h.itemId, qtyOnHand: h.qty })));
        }
        opened = { id: excursionId, no: excursionNumber(row!.seq), openedAt: takenAt.toISOString(), batches: held.length };
      }
    }
    await appendEvent(tx, coldReadingRecorded.make({
      actor, occurredAt: now, payload: { unitId: unit.id, readingId, currentC, minC, maxC, outOfRange, excursionId: opened?.id ?? null },
    }));
    return { readingId, outOfRange, opened };
  });
}

// ═══════════════════════════════════ the hold ═══════════════════════════════════

/**
 * THE GATE. Refuses any line whose batch, at this store, is held: on the frozen list of an OPEN excursion, or
 * decided `write_off` at an excursion's close. Called by `handOverDispense` and the walk-in sale, inside the
 * transaction that moves the stock.
 */
export async function assertNoColdChainHold(
  db: Db | Tx, storeResourceId: string | null, lines: readonly { lineIdx: number; batchId: string | null }[],
): Promise<void> {
  if (storeResourceId === null) return;
  const batchIds = [...new Set(lines.map((l) => l.batchId).filter((b): b is string => b !== null))];
  if (batchIds.length === 0) return;
  const open = await db.select({ batchId: pharmacyColdExcursionBatches.batchId, label: pharmacyColdUnits.label, seq: pharmacyColdExcursions.seq })
    .from(pharmacyColdExcursionBatches)
    .innerJoin(pharmacyColdExcursions, eq(pharmacyColdExcursions.id, pharmacyColdExcursionBatches.excursionId))
    .innerJoin(pharmacyColdUnits, eq(pharmacyColdUnits.id, pharmacyColdExcursions.unitId))
    .where(and(eq(pharmacyColdExcursions.storeResourceId, storeResourceId), isNull(pharmacyColdExcursions.closedAt), inArray(pharmacyColdExcursionBatches.batchId, batchIds)));
  const writtenOff = await db.select({ batchId: pharmacyColdExcursionDecisions.batchId, label: pharmacyColdUnits.label, seq: pharmacyColdExcursions.seq })
    .from(pharmacyColdExcursionDecisions)
    .innerJoin(pharmacyColdExcursions, eq(pharmacyColdExcursions.id, pharmacyColdExcursionDecisions.excursionId))
    .innerJoin(pharmacyColdUnits, eq(pharmacyColdUnits.id, pharmacyColdExcursions.unitId))
    .where(and(eq(pharmacyColdExcursions.storeResourceId, storeResourceId), eq(pharmacyColdExcursionDecisions.decision, "write_off"), inArray(pharmacyColdExcursionDecisions.batchId, batchIds)));
  if (open.length === 0 && writtenOff.length === 0) return;
  const heldOpen = new Map(open.map((h) => [h.batchId, h]));
  const heldOff = new Map(writtenOff.map((h) => [h.batchId, h]));
  const hit = lines.find((l) => l.batchId !== null && (heldOpen.has(l.batchId) || heldOff.has(l.batchId)))!;
  const o = heldOpen.get(hit.batchId!);
  const h = o ?? heldOff.get(hit.batchId!)!;
  const lineIdxs = lines.filter((l) => l.batchId !== null && (heldOpen.has(l.batchId) || heldOff.has(l.batchId))).map((l) => l.lineIdx);
  throw new PharmacyError(
    "cold_chain_excursion_open",
    o !== undefined
      ? `line ${String(hit.lineIdx + 1)}: fridge "${h.label}" had a temperature excursion (${excursionNumber(h.seq)}) and this batch is on hold until it is decided — call the pharmacy in-charge`
      : `line ${String(hit.lineIdx + 1)}: this batch was written off after fridge "${h.label}"'s temperature excursion (${excursionNumber(h.seq)}) and may not leave — call the pharmacy in-charge`,
    { unit: h.label, excursionNo: excursionNumber(h.seq), lineIdxs },
  );
}

// ═══════════════════════════════════ the close ═══════════════════════════════════

export type ColdDecisionInput = { batchId: string; decision: ColdExcursionDecision; reason?: string | null; qtyBase?: number };
export type CloseExcursionInput = { decisions: ColdDecisionInput[]; note?: string | null };

/**
 * Close an excursion: a decision for EVERY held batch, no more and no fewer. The write-offs are one materials
 * destruction write-off (reason `damage`) raised in this transaction through the materials module, which
 * checks its own grant (`materials.writeoffs.manage`) and the quantity; the MS approves it as any other.
 */
export async function closeColdExcursion(
  db: Db, actor: Actor, excursionId: string, input: CloseExcursionInput, now: Date = new Date(),
): Promise<{ excursionId: string; writeOffId: string | null }> {
  const userId = await requirePerm(db, actor, COLDCHAIN_MANAGE_PERMISSION, "closing a cold-chain excursion");
  const note = clean(input.note);
  for (const d of input.decisions) {
    if (!(COLD_EXCURSION_DECISIONS as readonly string[]).includes(d.decision)) bad(`"${String(d.decision)}" is not release or write_off`);
    if (d.decision === "release" && clean(d.reason) === null) bad("a release says why the batch is still good — the product's stability data");
    if (d.qtyBase !== undefined && (!Number.isSafeInteger(d.qtyBase) || d.qtyBase <= 0)) bad("a write-off quantity is a whole number of base units, at least one");
  }
  return withTx(db, async (tx) => {
    const [ex] = await tx.select().from(pharmacyColdExcursions).where(eq(pharmacyColdExcursions.id, excursionId)).for("update");
    if (ex === undefined) throw new PharmacyError("unknown_excursion", `excursion ${excursionId} not found`);
    if (ex.closedAt !== null) throw new PharmacyError("excursion_closed", `${excursionNumber(ex.seq)} is closed — a closed excursion takes no further act`);
    const held = await tx.select().from(pharmacyColdExcursionBatches).where(eq(pharmacyColdExcursionBatches.excursionId, ex.id));
    const heldIds = new Set(held.map((b) => b.batchId));
    const decided = new Set<string>();
    for (const d of input.decisions) {
      if (!heldIds.has(d.batchId)) bad(`batch ${d.batchId} is not held by ${excursionNumber(ex.seq)}`, { batchId: d.batchId });
      if (decided.has(d.batchId)) bad("a batch is decided once", { batchId: d.batchId });
      decided.add(d.batchId);
    }
    const missing = held.filter((b) => !decided.has(b.batchId)).map((b) => b.batchId);
    if (missing.length > 0) bad(`decide every held batch — ${String(missing.length)} still undecided`, { batchIds: missing });

    const offs = input.decisions.filter((d) => d.decision === "write_off");
    let writeOffId: string | null = null;
    if (offs.length > 0) {
      const bals = await tx.select().from(stockBalances)
        .where(and(eq(stockBalances.resourceId, ex.storeResourceId), inArray(stockBalances.batchId, offs.map((d) => d.batchId))));
      const lines = offs.map((d) => {
        const b = bals.find((x) => x.batchId === d.batchId);
        const free = b === undefined ? 0 : b.qtyOnHand - b.qtyReserved - b.qtyFrozen;
        const qtyBase = d.qtyBase ?? free;
        if (qtyBase <= 0) bad("this batch has nothing free on the shelf to write off — release the stock held for dispenses first, or name the quantity", { batchId: d.batchId });
        return { batchId: d.batchId, qtyBase };
      });
      const [unit] = await tx.select({ label: pharmacyColdUnits.label }).from(pharmacyColdUnits).where(eq(pharmacyColdUnits.id, ex.unitId));
      const wo = await raiseWriteOff(tx as unknown as Db, actor, {
        storeResourceId: ex.storeResourceId, reason: "damage", lines,
        note: `cold-chain excursion ${excursionNumber(ex.seq)} at fridge "${unit?.label ?? ex.unitId}"${note === null ? "" : ` — ${note}`}`,
      }, now);
      writeOffId = wo.id;
    }
    /* An excursion that held nothing (no cold stock on hand when it opened) closes with no decision rows. */
    if (input.decisions.length > 0) {
      await tx.insert(pharmacyColdExcursionDecisions).values(input.decisions.map((d) => ({
        id: newId(), excursionId: ex.id, batchId: d.batchId, decision: d.decision,
        reason: d.decision === "release" ? clean(d.reason) : null, writeOffId: d.decision === "write_off" ? writeOffId : null,
        decidedBy: userId, decidedAt: now,
      })));
    }
    await tx.insert(pharmacyColdExcursionCloses).values({ excursionId: ex.id, note, closedBy: userId, closedAt: now });
    await tx.update(pharmacyColdExcursions).set({ closedAt: now }).where(eq(pharmacyColdExcursions.id, ex.id));
    await appendEvent(tx, coldExcursionClosed.make({
      actor, occurredAt: now, correlationId: ex.id,
      payload: { excursionId: ex.id, unitId: ex.unitId, released: input.decisions.length - offs.length, writtenOff: offs.length, writeOffId },
    }));
    return { excursionId: ex.id, writeOffId };
  });
}

// ═══════════════════════════════════ reads ═══════════════════════════════════

/** The instant an IST wall-clock `HH:MM` falls on an IST day (the hospital clock lives in `config.ts`). */
const istInstant = (day: string, hhmm: string): number => istInstantOf(day, hhmm).getTime();

/** Today's two slots for one fridge, from the readings taken today. Pure. */
export function slotsOf(
  day: string, readings: readonly { id: string; takenAt: Date }[], unitCreatedAt: Date, now: Date,
): ColdSlot[] {
  return COLD_SLOTS_IST.map((slot) => {
    const at = istInstant(day, slot);
    const from = at - COLD_SLOT_EARLY_MINUTES * MINUTE;
    const until = at + COLD_SLOT_GRACE_MINUTES * MINUTE;
    const r = readings.find((x) => x.takenAt.getTime() >= from && x.takenAt.getTime() <= until);
    if (r !== undefined) return { slot, state: "done" as const, readingId: r.id };
    /* A fridge added after a slot's deadline did not miss it. */
    if (unitCreatedAt.getTime() > until) return { slot, state: "not_due" as const, readingId: null };
    const t = now.getTime();
    return { slot, state: t > until ? "missed" as const : t >= from ? "due" as const : "upcoming" as const, readingId: null };
  });
}

function readingView(r: typeof pharmacyColdReadings.$inferSelect, low: number, high: number, name: string | null): ColdReadingView {
  return {
    id: r.id, unitId: r.unitId, currentC: r.currentC, minC: r.minC, maxC: r.maxC,
    outOfRange: [r.currentC, r.minC, r.maxC].some((c) => outside(Number(c), low, high)),
    takenAt: r.takenAt.toISOString(), takenByName: name, note: r.note,
  };
}

async function namesOf(db: Db, ids: string[]): Promise<Map<string, string>> {
  const u = [...new Set(ids)];
  if (u.length === 0) return new Map();
  const rows = await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, u));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Every fridge (active first), with today's two slots, its last reading and any open excursion. */
export async function listColdUnits(db: Db, actor: Actor, now: Date = new Date()): Promise<ColdUnitView[]> {
  await assertColdReader(db, actor);
  const units = await db.select({ u: pharmacyColdUnits, code: resources.code, name: resources.name }).from(pharmacyColdUnits)
    .innerJoin(resources, eq(resources.id, pharmacyColdUnits.storeResourceId))
    .orderBy(desc(pharmacyColdUnits.active), asc(resources.code), asc(pharmacyColdUnits.label)).limit(LIST_LIMIT);
  if (units.length === 0) return [];
  const ids = units.map((x) => x.u.id);
  const day = istDateOf(now);
  const dayStart = new Date(istInstant(day, "00:00"));
  const today = await db.select().from(pharmacyColdReadings)
    .where(and(inArray(pharmacyColdReadings.unitId, ids), gte(pharmacyColdReadings.takenAt, dayStart)))
    .orderBy(asc(pharmacyColdReadings.takenAt));
  const last = await db.selectDistinctOn([pharmacyColdReadings.unitId]).from(pharmacyColdReadings)
    .where(inArray(pharmacyColdReadings.unitId, ids))
    .orderBy(pharmacyColdReadings.unitId, desc(pharmacyColdReadings.takenAt), desc(pharmacyColdReadings.recordedAt));
  const open = await db.select({ e: pharmacyColdExcursions, n: sql<number>`(select count(*)::int from ${pharmacyColdExcursionBatches} b where b.excursion_id = ${pharmacyColdExcursions.id})` })
    .from(pharmacyColdExcursions).where(and(inArray(pharmacyColdExcursions.unitId, ids), isNull(pharmacyColdExcursions.closedAt)));
  const names = await namesOf(db, last.map((r) => r.takenBy));
  return units.map(({ u, code, name }) => {
    const low = Number(u.lowC);
    const high = Number(u.highC);
    const l = last.find((r) => r.unitId === u.id);
    const o = open.find((x) => x.e.unitId === u.id);
    return {
      id: u.id, label: u.label, lowC: u.lowC, highC: u.highC, active: u.active, store: { id: u.storeResourceId, code, name },
      slots: u.active ? slotsOf(day, today.filter((r) => r.unitId === u.id), u.createdAt, now) : [],
      lastReading: l === undefined ? null : readingView(l, low, high, names.get(l.takenBy) ?? null),
      openExcursion: o === undefined ? null : { id: o.e.id, no: excursionNumber(o.e.seq), openedAt: o.e.openedAt.toISOString(), batches: o.n },
    };
  });
}

/** One fridge's readings, newest first, over the last `days` IST days (default 7, at most 90). */
export async function listColdReadings(db: Db, actor: Actor, unitId: string, opts: { days?: number } = {}, now: Date = new Date()): Promise<ColdReadingView[]> {
  await assertColdReader(db, actor);
  const [unit] = await db.select().from(pharmacyColdUnits).where(eq(pharmacyColdUnits.id, unitId));
  if (unit === undefined) throw new PharmacyError("unknown_cold_unit", `fridge ${unitId} not found`);
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 7), 1), 90);
  const from = new Date(istInstant(istDateOf(now), "00:00") - (days - 1) * 24 * 60 * MINUTE);
  const rows = await db.select().from(pharmacyColdReadings)
    .where(and(eq(pharmacyColdReadings.unitId, unitId), gte(pharmacyColdReadings.takenAt, from)))
    .orderBy(desc(pharmacyColdReadings.takenAt), desc(pharmacyColdReadings.recordedAt)).limit(LIST_LIMIT);
  const names = await namesOf(db, rows.map((r) => r.takenBy));
  return rows.map((r) => readingView(r, Number(unit.lowC), Number(unit.highC), names.get(r.takenBy) ?? null));
}

/** The excursions, newest first; `open` keeps those not yet closed. */
export async function listColdExcursions(db: Db, actor: Actor, opts: { open?: boolean } = {}): Promise<ColdExcursionView[]> {
  await assertColdReader(db, actor);
  const rows = await db.select({ e: pharmacyColdExcursions, label: pharmacyColdUnits.label, code: resources.code, name: resources.name, r: pharmacyColdReadings })
    .from(pharmacyColdExcursions)
    .innerJoin(pharmacyColdUnits, eq(pharmacyColdUnits.id, pharmacyColdExcursions.unitId))
    .innerJoin(resources, eq(resources.id, pharmacyColdExcursions.storeResourceId))
    .innerJoin(pharmacyColdReadings, eq(pharmacyColdReadings.id, pharmacyColdExcursions.readingId))
    .where(opts.open === true ? isNull(pharmacyColdExcursions.closedAt) : undefined)
    .orderBy(desc(pharmacyColdExcursions.seq)).limit(LIST_LIMIT);
  if (rows.length === 0) return [];
  const ids = rows.map((x) => x.e.id);
  const [batches, decisions, closes] = await Promise.all([
    db.select({ b: pharmacyColdExcursionBatches, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate, itemName: items.name })
      .from(pharmacyColdExcursionBatches)
      .innerJoin(stockBatches, eq(stockBatches.id, pharmacyColdExcursionBatches.batchId))
      .innerJoin(items, eq(items.id, pharmacyColdExcursionBatches.itemId))
      .where(inArray(pharmacyColdExcursionBatches.excursionId, ids)).orderBy(asc(items.name), asc(stockBatches.batchNo)),
    db.select().from(pharmacyColdExcursionDecisions).where(inArray(pharmacyColdExcursionDecisions.excursionId, ids)),
    db.select().from(pharmacyColdExcursionCloses).where(inArray(pharmacyColdExcursionCloses.excursionId, ids)),
  ]);
  const names = await namesOf(db, closes.map((c) => c.closedBy));
  return rows.map(({ e, label, code, name, r }): ColdExcursionView => {
    const c = closes.find((x) => x.excursionId === e.id);
    return {
      id: e.id, no: excursionNumber(e.seq), unit: { id: e.unitId, label }, store: { id: e.storeResourceId, code, name },
      lowC: e.lowC, highC: e.highC, openedAt: e.openedAt.toISOString(),
      reading: { id: r.id, currentC: r.currentC, minC: r.minC, maxC: r.maxC, takenAt: r.takenAt.toISOString() },
      batches: batches.filter((x) => x.b.excursionId === e.id).map(({ b, batchNo, expiryDate, itemName }) => {
        const d = decisions.find((x) => x.excursionId === e.id && x.batchId === b.batchId);
        return {
          batchId: b.batchId, batchNo, expiryDate, itemId: b.itemId, itemName, qtyOnHand: b.qtyOnHand,
          decision: d === undefined ? null : { decision: d.decision as ColdExcursionDecision, reason: d.reason, writeOffId: d.writeOffId, decidedAt: d.decidedAt.toISOString() },
        };
      }),
      closed: c === undefined ? null : { closedAt: c.closedAt.toISOString(), closedByName: names.get(c.closedBy) ?? null, note: c.note },
    };
  });
}

/** The office's STOCK side: today's missed slots, and every open excursion. Codes and names only. */
export type ColdChainToday = {
  missed: { unitId: string; label: string; storeCode: string; slot: string; day: string }[];
  open: { id: string; no: string; unitId: string; label: string; storeCode: string; openedAt: string; batches: number }[];
};

export async function coldChainToday(db: Db, actor: Actor, now: Date = new Date()): Promise<ColdChainToday> {
  const units = await listColdUnits(db, actor, now);
  const day = istDateOf(now);
  return {
    missed: units.flatMap((u) => u.slots.filter((s) => s.state === "missed").map((s) => ({ unitId: u.id, label: u.label, storeCode: u.store.code, slot: s.slot, day }))),
    open: units.flatMap((u) => (u.openExcursion === null ? [] : [{
      id: u.openExcursion.id, no: u.openExcursion.no, unitId: u.id, label: u.label, storeCode: u.store.code,
      openedAt: u.openExcursion.openedAt, batches: u.openExcursion.batches,
    }])),
  };
}
