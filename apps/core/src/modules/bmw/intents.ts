import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  BMW_CATEGORIES, bagWeightInput, bmwGapBasisPoints, bmwGapFlagged, collectBagInput, generateBagInput, handOverManifestInput,
  newId, recordCbwtfWeightInput, resolveDisputeInput, storeBagInput,
} from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { bmwBagEvents, bmwBags, bmwDisputes, bmwManifests, resources, tasks } from "../../kernel/db/schema";
import { enqueuePrintJob } from "../../kernel/printing/enqueue";
import { relayServes } from "../../kernel/printing/served";
import { TaskError, acceptTask, cancelTask, completeTask, raiseTask, startTask } from "../tasks";
import { BmwError } from "./errors";
import { BMW_COLLECTION_TASK } from "./kinds";
import { BAG_LABEL_DOCUMENT, drawBagLabel } from "./label";
import type { Actor, BmwAct, BmwCategory, BmwLabelDelivery, BmwSource } from "@hmis/contracts";
import type { z } from "zod";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ THE INTENTS ═══
 *
 * Every function is one act on a bag (or a manifest of bags). Each parses its input with the contract's zod
 * schema, refuses with a `BmwError` (code + sentence + fix), and changes the bag row and appends exactly one
 * `bmw_bag_events` row per change in ONE transaction, the event's `seq` being the bag's new `version`.
 *
 * Authority is the caller's: the HTTP doors check `bmw.handle` / `bmw.manage`. Every instant is the caller's
 * `now` (the doors pass the real clock; tests pass their own), never read twice.
 */
export type BagRow = typeof bmwBags.$inferSelect;
export type ManifestRow = typeof bmwManifests.$inferSelect;
export type DisputeRow = typeof bmwDisputes.$inferSelect;
type Exec = Db | Tx;

export const BMW_SYSTEM: Actor = { type: "system", id: "bmw" };

const CATEGORY_CODE: Record<BmwCategory, string> = { yellow: "Y", red: "R", white_translucent: "W", blue: "B" };

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new BmwError("bad_input", { issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  return r.data;
}

function sourceOf(actor: Actor): BmwSource {
  if (actor.type === "system") return "system";
  return actor.type === "agent" ? "agent" : "person";
}

const tx = <T>(exec: Exec, fn: (t: Tx) => Promise<T>): Promise<T> => (exec as Db).transaction(fn);
const norm = (code: string): string => code.trim().toUpperCase();

/** Change a bag and append its event, in the caller's transaction. */
async function actOn(
  t: Tx, bagId: string, set: PgUpdateSetSource<typeof bmwBags>, act: BmwAct, actor: Actor, now: Date, detail: Record<string, unknown> = {},
): Promise<BagRow> {
  const row = (await t.update(bmwBags).set({ ...set, version: sql`${bmwBags.version} + 1`, updatedAt: now })
    .where(eq(bmwBags.id, bagId)).returning())[0];
  if (row === undefined) throw new BmwError("unknown_bag", { bagId });
  await t.insert(bmwBagEvents).values({
    bagId: row.id, seq: row.version, act, actorType: actor.type, actorId: actor.id, source: sourceOf(actor), at: now, detail,
  });
  return row;
}

async function lockByBarcode(t: Tx, barcode: string): Promise<BagRow> {
  const row = (await t.select().from(bmwBags).where(eq(bmwBags.barcode, norm(barcode))).for("update"))[0];
  if (row === undefined) throw new BmwError("unknown_bag", { barcode: norm(barcode) });
  return row;
}

/** The bar code: BMW + colour letter(s) + IST date YYMMDD + a six-digit serial from `bmw_bag_serial`. Never reused. */
export function formatBarcode(category: BmwCategory, cytotoxic: boolean, now: Date, serial: number): string {
  const day = istDayString(now).replace(/-/g, "").slice(2);
  return `BMW${CATEGORY_CODE[category]}${cytotoxic ? "C" : ""}${day}${String(serial).padStart(6, "0")}`;
}

/* ═══════════════════════════════ generate ═══════════════════════════════ */

export type GenerateResult = { bag: BagRow; label: BmwLabelDelivery; taskId: string | null };

/**
 * A new bag at a place: a unique bar code, its label (to the label printer when a relay serves it, otherwise
 * back to this browser), and a `bmw_collection` task at the place (merged with one raised in the last ten minutes).
 */
export async function generateBag(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<GenerateResult> {
  const input = parse(generateBagInput, raw);
  const cytotoxic = input.cytotoxic ?? false;
  if (cytotoxic && input.category !== "yellow") throw new BmwError("cytotoxic_not_yellow");
  const relay = await relayServes(exec, "bmw_label", now);
  return tx(exec, async (t) => {
    const place = (await t.select({ id: resources.id, name: resources.name, status: resources.status }).from(resources)
      .where(eq(resources.id, input.placeResourceId)))[0];
    if (place === undefined || place.status === "retired") throw new BmwError("unknown_place", { placeResourceId: input.placeResourceId });
    const serial = Number((await t.execute<{ n: string }>(sql`select nextval('bmw_bag_serial') as n`)).rows[0]!.n);
    const barcode = formatBarcode(input.category, cytotoxic, now, serial);
    const inserted = (await t.insert(bmwBags).values({
      id: newId(), barcode, category: input.category, cytotoxic, placeResourceId: place.id, generatedAt: now, generatedBy: actor.id,
      deptWeightGrams: input.deptWeightGrams ?? null, deptWeighedAt: input.deptWeightGrams === undefined ? null : now,
      state: "generated", source: actor.type === "agent" ? "agent" : "person", createdAt: now, updatedAt: now, version: 1,
    }).returning())[0]!;
    await t.insert(bmwBagEvents).values({
      bagId: inserted.id, seq: 1, act: "generated", actorType: actor.type, actorId: actor.id, source: sourceOf(actor), at: now,
      detail: { barcode, category: input.category, cytotoxic, deptWeightGrams: input.deptWeightGrams ?? null },
    });
    const { task } = await raiseTask(t, actor, { kind: BMW_COLLECTION_TASK.kind, placeResourceId: place.id }, now);
    let label: BmwLabelDelivery;
    if (relay) {
      const jobId = await enqueuePrintJob(t, {
        document: BAG_LABEL_DOCUMENT, params: { bagId: inserted.id }, dedupeKey: `${BAG_LABEL_DOCUMENT}:${inserted.id}`,
        requestedBy: actor.type === "user" ? actor.id : null,
      });
      label = { via: "relay", jobId };
    } else {
      label = { via: "browser", document: drawBagLabel({ ...inserted, category: input.category, placeName: place.name }) };
    }
    return { bag: inserted, label, taskId: task.id };
  });
}

/* ═══════════════════════════════ weigh, collect, store ═══════════════════════════════ */

/** The department weight, at the ward's collection point, before the bag leaves. Once. */
export async function recordDeptWeight(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<BagRow> {
  const input = parse(bagWeightInput, raw);
  return tx(exec, async (t) => {
    const bag = await lockByBarcode(t, input.barcode);
    if (bag.state !== "generated") throw new BmwError("wrong_state", { barcode: bag.barcode, state: bag.state });
    if (bag.deptWeightGrams !== null) throw new BmwError("already_weighed", { barcode: bag.barcode });
    return actOn(t, bag.id, { deptWeightGrams: input.grams, deptWeighedAt: now }, "dept_weighed", actor, now, { grams: input.grams });
  });
}

/**
 * The handler scans the bag at the ward and takes it. Unweighed bags are weighed in the same act (`grams`).
 * When it was the place's last waiting bag, the place's `bmw_collection` task is closed with this scan as proof — or
 * cancelled ("Bags collected") when the collector cannot hold it (not on duty, not of the skill).
 */
export async function collectBag(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<BagRow> {
  const input = parse(collectBagInput, raw);
  return tx(exec, async (t) => {
    let bag = await lockByBarcode(t, input.barcode);
    if (bag.state !== "generated") throw new BmwError(bag.manifestId !== null ? "already_handed_over" : "wrong_state", { barcode: bag.barcode, state: bag.state });
    if (bag.deptWeightGrams === null) {
      if (input.grams === undefined) throw new BmwError("weight_needed", { barcode: bag.barcode });
      bag = await actOn(t, bag.id, { deptWeightGrams: input.grams, deptWeighedAt: now }, "dept_weighed", actor, now, { grams: input.grams });
    } else if (input.grams !== undefined) {
      throw new BmwError("already_weighed", { barcode: bag.barcode });
    }
    bag = await actOn(t, bag.id, { state: "collected", collectedAt: now, collectedBy: actor.id }, "collected", actor, now);
    await closeCollectionTask(t, actor, bag, now);
    return bag;
  });
}

/** The place's collection task is done when no bag waits there any more. Held by someone else: cancelled, not stolen. */
async function closeCollectionTask(t: Tx, actor: Actor, bag: BagRow, now: Date): Promise<void> {
  const waiting = (await t.select({ n: sql<number>`count(*)::int` }).from(bmwBags)
    .where(and(eq(bmwBags.placeResourceId, bag.placeResourceId), eq(bmwBags.state, "generated"), ne(bmwBags.id, bag.id))))[0]!.n;
  if (waiting > 0) return;
  const open = await t.select().from(tasks).where(and(
    eq(tasks.kind, BMW_COLLECTION_TASK.kind), eq(tasks.placeResourceId, bag.placeResourceId),
    inArray(tasks.state, ["created", "assigned", "accepted", "in_progress"]),
  )).orderBy(asc(tasks.createdAt));
  for (const task of open) {
    if (actor.type !== "user" || (task.assigneeId !== null && task.assigneeId !== actor.id)) {
      await cancelTask(t, BMW_SYSTEM, { taskId: task.id, reason: "Bags collected" }, now);
      continue;
    }
    let row = task;
    if (row.state === "created" || row.state === "assigned") {
      try {
        row = await acceptTask(t, actor, { taskId: row.id }, now);
      } catch (e) {
        // The collector may not hold the task (off the roster, or a supervisor without the skill): the bags are
        // still collected, so the task is closed as cancelled rather than left for someone to walk to an empty ward.
        if (!(e instanceof TaskError) || (e.code !== "not_on_duty" && e.code !== "wrong_skill")) throw e;
        await cancelTask(t, BMW_SYSTEM, { taskId: row.id, reason: "Bags collected" }, now);
        continue;
      }
    }
    if (row.state === "accepted") row = await startTask(t, actor, { taskId: row.id }, now);
    await completeTask(t, actor, { taskId: row.id, proof: { kind: "scan", code: bag.barcode } }, now);
  }
}

/** Into the central store: the central weight is taken, and the storage time starts the store's own record. */
export async function storeBag(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<{ bag: BagRow; centralGap: boolean }> {
  const input = parse(storeBagInput, raw);
  return tx(exec, async (t) => {
    const bag = await lockByBarcode(t, input.barcode);
    if (bag.state !== "collected") throw new BmwError(bag.manifestId !== null ? "already_handed_over" : "wrong_state", { barcode: bag.barcode, state: bag.state });
    const centralGap = bmwGapFlagged(bag.deptWeightGrams ?? 0, input.grams);
    const row = await actOn(t, bag.id, { state: "stored", centralWeightGrams: input.grams, storageInAt: now, storedBy: actor.id }, "stored", actor, now, {
      grams: input.grams, centralGap,
    });
    return { bag: row, centralGap };
  });
}

/* ═══════════════════════════════ hand over ═══════════════════════════════ */

export type ManifestTotals = Record<string, { bags: number; deptGrams: number; centralGrams: number }>;

/**
 * The CBWTF vehicle takes stored bags: one manifest, every bag on it moved to `handed_over` with the manifest's
 * id. The bags are locked FOR UPDATE in id order, so a second handover of the same bag waits for the first and
 * then finds it gone (`already_handed_over`); the bag row's CHECK keeps a manifest id once set.
 */
export async function handOverManifest(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<ManifestRow> {
  const input = parse(handOverManifestInput, raw);
  const codes = input.barcodes.map(norm);
  if (new Set(codes).size !== codes.length) throw new BmwError("duplicate_bag");
  return tx(exec, async (t) => {
    const bags = await t.select().from(bmwBags).where(inArray(bmwBags.barcode, codes)).orderBy(asc(bmwBags.id)).for("update");
    const found = new Set(bags.map((b) => b.barcode));
    const missing = codes.filter((c) => !found.has(c));
    if (missing.length > 0) throw new BmwError("unknown_bag", { barcodes: missing });
    const gone = bags.filter((b) => b.manifestId !== null);
    if (gone.length > 0) throw new BmwError("already_handed_over", { barcodes: gone.map((b) => b.barcode) });
    const notStored = bags.filter((b) => b.state !== "stored");
    if (notStored.length > 0) throw new BmwError("not_stored", { barcodes: notStored.map((b) => b.barcode) });

    const totals: ManifestTotals = {};
    for (const b of bags) {
      const c = totals[b.category] ?? { bags: 0, deptGrams: 0, centralGrams: 0 };
      c.bags += 1;
      c.deptGrams += b.deptWeightGrams ?? 0;
      c.centralGrams += b.centralWeightGrams ?? 0;
      totals[b.category] = c;
    }
    const serial = Number((await t.execute<{ n: string }>(sql`select nextval('bmw_manifest_serial') as n`)).rows[0]!.n);
    const manifestNo = `MF-${istDayString(now).replace(/-/g, "")}-${String(serial).padStart(4, "0")}`;
    const manifest = (await t.insert(bmwManifests).values({
      id: newId(), manifestNo, cbwtfName: input.cbwtfName, vehicleNo: input.vehicleNo.toUpperCase(), operatorName: input.operatorName ?? null,
      handedOverAt: now, handedOverBy: actor.id, bagCount: bags.length, totals, createdAt: now,
    }).returning())[0]!;
    for (const b of bags) {
      await actOn(t, b.id, { state: "handed_over", manifestId: manifest.id, handedOverAt: now }, "handed_over", actor, now, { manifestNo });
    }
    return manifest;
  });
}

/* ═══════════════════════════════ the facility's weight, and the gap ═══════════════════════════════ */

export type CategoryGap = { category: BmwCategory; deptGrams: number; cbwtfGrams: number; gapBasisPoints: number; flagged: boolean };

/**
 * VERIFY GAP — per category of a manifest: the department's weight of its bags against the facility's. Read from
 * the bag rows, so it says the same thing before and after a dispute is resolved. Categories the facility has not
 * weighed are absent.
 */
export async function verifyManifestGap(exec: Exec, manifestId: string): Promise<CategoryGap[]> {
  const bags = await (exec as Db).select().from(bmwBags).where(eq(bmwBags.manifestId, manifestId));
  return gapsOf(bags);
}

function gapsOf(bags: readonly BagRow[]): CategoryGap[] {
  const out: CategoryGap[] = [];
  for (const category of BMW_CATEGORIES) {
    const weighed = bags.filter((b) => b.category === category && b.cbwtfWeightGrams !== null);
    if (weighed.length === 0) continue;
    const deptGrams = weighed.reduce((n, b) => n + (b.deptWeightGrams ?? 0), 0);
    const cbwtfGrams = weighed.reduce((n, b) => n + b.cbwtfWeightGrams!, 0);
    out.push({ category, deptGrams, cbwtfGrams, gapBasisPoints: bmwGapBasisPoints(deptGrams, cbwtfGrams), flagged: bmwGapFlagged(deptGrams, cbwtfGrams) });
  }
  return out;
}

/**
 * Split a category's slip weight over its bags in proportion to their department weights (largest remainder), so
 * the bag rows sum to the slip EXACTLY and every report can be read off the bags. DECIDED: the facility's
 * weighbridge slip is per colour; the split is arithmetic, and the event says so (`allocated: true`).
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((n, w) => n + w, 0);
  if (weights.length === 0) return [];
  const raw = weights.map((w) => (sum === 0 ? total / weights.length : (total * w) / sum));
  const floor = raw.map((r) => Math.floor(r));
  let left = total - floor.reduce((n, f) => n + f, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  for (const o of order) {
    if (left <= 0) break;
    floor[o.i]! += 1;
    left -= 1;
  }
  return floor;
}

export type CbwtfResult = { manifest: ManifestRow; gaps: CategoryGap[]; disputes: DisputeRow[] };

/**
 * The facility's weights arrive (per bag from their scan, or per colour from their slip). Each weighed bag is
 * received: `treated` with `treated_at = now` — or `disputed` when its category's gap is ≥ 6 %, in which case a
 * dispute row is written with both weights (one per manifest and category). Once per manifest.
 */
export async function recordCbwtfWeight(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<CbwtfResult> {
  const input = parse(recordCbwtfWeightInput, raw);
  return tx(exec, async (t) => {
    const manifest = (await t.select().from(bmwManifests).where(eq(bmwManifests.id, input.manifestId)).for("update"))[0];
    if (manifest === undefined) throw new BmwError("unknown_manifest", { manifestId: input.manifestId });
    if (manifest.cbwtfRecordedAt !== null) throw new BmwError("already_recorded", { manifestId: manifest.id });
    const bags = await t.select().from(bmwBags).where(eq(bmwBags.manifestId, manifest.id)).orderBy(asc(bmwBags.id)).for("update");
    const byCode = new Map(bags.map((b) => [b.barcode, b]));
    const weight = new Map<string, { grams: number; allocated: boolean }>();
    for (const w of input.byBag ?? []) {
      const bag = byCode.get(norm(w.barcode));
      if (bag === undefined) throw new BmwError("not_on_manifest", { barcode: norm(w.barcode) });
      weight.set(bag.id, { grams: w.grams, allocated: false });
    }
    for (const c of input.byCategory ?? []) {
      const ofCat = bags.filter((b) => b.category === c.category);
      if (ofCat.length === 0) throw new BmwError("category_not_on_manifest", { category: c.category });
      const shares = allocate(c.grams, ofCat.map((b) => b.deptWeightGrams ?? 0));
      ofCat.forEach((b, i) => weight.set(b.id, { grams: shares[i]!, allocated: true }));
    }
    const weighed = bags.map((b) => (weight.has(b.id) ? { ...b, cbwtfWeightGrams: weight.get(b.id)!.grams } : b));
    const gaps = gapsOf(weighed.filter((b) => weight.has(b.id)));
    const flagged = new Set(gaps.filter((g) => g.flagged).map((g) => g.category));
    for (const b of bags) {
      const w = weight.get(b.id);
      if (w === undefined || w.grams <= 0) continue;
      await actOn(t, b.id, { cbwtfWeightGrams: w.grams }, "cbwtf_weighed", actor, now, { grams: w.grams, allocated: w.allocated });
      const disputed = flagged.has(b.category as BmwCategory);
      await actOn(t, b.id, { state: disputed ? "disputed" : "treated", treatedAt: now }, disputed ? "disputed" : "treated", actor, now);
    }
    const disputes: DisputeRow[] = [];
    for (const g of gaps.filter((x) => x.flagged)) {
      disputes.push((await t.insert(bmwDisputes).values({
        id: newId(), manifestId: manifest.id, category: g.category, deptGrams: g.deptGrams, cbwtfGrams: g.cbwtfGrams,
        gapBasisPoints: g.gapBasisPoints, state: "open", openedAt: now, openedBy: actor.id,
      }).returning())[0]!);
    }
    const cbwtfTotals = Object.fromEntries(gaps.map((g) => [g.category, g.cbwtfGrams]));
    const updated = (await t.update(bmwManifests).set({ cbwtfRecordedAt: now, cbwtfRecordedBy: actor.id, cbwtfTotals })
      .where(eq(bmwManifests.id, manifest.id)).returning())[0]!;
    return { manifest: updated, gaps, disputes };
  });
}

/** The supervisor closes a dispute with a note (the facility's revised slip, or the hospital accepts). Its bags become `treated`. */
export async function resolveDispute(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<DisputeRow> {
  const input = parse(resolveDisputeInput, raw);
  return tx(exec, async (t) => {
    const d = (await t.select().from(bmwDisputes).where(eq(bmwDisputes.id, input.disputeId)).for("update"))[0];
    if (d === undefined) throw new BmwError("unknown_dispute", { disputeId: input.disputeId });
    if (d.state !== "open") throw new BmwError("dispute_closed", { disputeId: d.id });
    const bags = await t.select().from(bmwBags)
      .where(and(eq(bmwBags.manifestId, d.manifestId), eq(bmwBags.category, d.category), eq(bmwBags.state, "disputed"))).for("update");
    for (const b of bags) await actOn(t, b.id, { state: "treated" }, "resolved", actor, now, { disputeId: d.id, note: input.note });
    return (await t.update(bmwDisputes).set({ state: "resolved", resolvedAt: now, resolvedBy: actor.id, resolutionNote: input.note })
      .where(eq(bmwDisputes.id, d.id)).returning())[0]!;
  });
}
