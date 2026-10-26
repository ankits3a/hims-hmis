import { and, eq, inArray, sql } from "drizzle-orm";
import {
  borrowBetweenWardsInput, decideCondemnInput, newId, receiveFromLaundryInput, recordSoiledInput, recordWardCountInput,
  requestCondemnInput, sendToLaundryInput, setParLevelInput, topUpWardInput,
} from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import {
  linenBags, linenCondemnRequests, linenItems, linenLaundryBatches, linenMovements, linenParLevels, linenVariances, linenWardCounts,
  resources,
} from "../../kernel/db/schema";
import { LinenError } from "./errors";
import { releaseLinenWaits } from "./gate";
import { requireNotHeld } from "./holds";
import { bookBalances, soiledPool, wardStates } from "./reads";
import type { Actor, LinenActResult, LinenMovementKind, LinenSource, LinenStream } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ THE INTENTS ═══
 *
 * Each function is one act. It parses its input with the contract's zod schema, refuses with a `LinenError` (code +
 * sentence + fix), and writes the ledger (one `linen_movements` row per item) in ONE transaction. Every instant is the
 * caller's `now` (the doors pass the real clock; tests pass their own), read once.
 *
 * Authority is the door's: `linen.handle` for the floor acts, `linen.manage` for par and condemn decisions. The one
 * rule an intent enforces about WHO is the four-eyes rule on a condemn: the approver is never the requester.
 */
export type MovementRow = typeof linenMovements.$inferSelect;
export type BatchRow = typeof linenLaundryBatches.$inferSelect;
export type CondemnRow = typeof linenCondemnRequests.$inferSelect;
export type Exec = Db | Tx;
export type Line = { itemCode: string; qty: number };

export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new LinenError("bad_input", { issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  return r.data;
}

export function sourceOf(actor: Actor): LinenSource {
  if (actor.type === "system") return "system";
  return actor.type === "agent" ? "agent" : "person";
}

export const tx = <T>(exec: Exec, fn: (t: Tx) => Promise<T>): Promise<T> => (exec as Db).transaction(fn);

/** One act at a time per ward (and one for the soiled room): the balance an act reads is the balance it writes on. */
export async function lock(t: Tx, key: string): Promise<void> {
  await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`linen:${key}`}))`);
}

/**
 * THE INSTANT OF AN ACT (PR #752 review): the caller's `now` when given (tests), otherwise the database's
 * `clock_timestamp()` read AFTER the act's lock — never the controller's clock read before it, so two acts queued on one
 * ward are stamped in the order they wrote. (`now()` would be the transaction's start, which is before the lock too.)
 */
export async function stamp(t: Tx, given: Date | undefined): Promise<Date> {
  if (given !== undefined) return given;
  const r = await t.execute<{ n: Date | string }>(sql`select clock_timestamp() as n`);
  return new Date(r.rows[0]!.n);
}

/** Refuse any line above the ward's book balance of that item (`exceeds_on_hand`). Call under the ward lock. */
export async function requireOnHand(t: Tx, wardId: string, lines: readonly Line[], now: Date): Promise<void> {
  const book = (await bookBalances(t, now, wardId)).get(wardId);
  for (const l of lines) {
    const onHand = book?.get(l.itemCode)?.onHand ?? 0;
    if (l.qty > onHand) throw new LinenError("exceeds_on_hand", { itemCode: l.itemCode, onHand, wardId });
  }
}

export async function requireWard(exec: Exec, wardId: string): Promise<{ id: string; name: string }> {
  const row = (await exec.select({ id: resources.id, name: resources.name, kind: resources.kind, status: resources.status })
    .from(resources).where(eq(resources.id, wardId)))[0];
  if (row === undefined || row.kind !== "ward" || row.status === "retired") throw new LinenError("unknown_ward", { wardId });
  return { id: row.id, name: row.name };
}

/** Every line's item exists and is active, and no item is listed twice. */
export async function requireItems(exec: Exec, lines: readonly Line[]): Promise<void> {
  const codes = lines.map((l) => l.itemCode);
  const dup = codes.find((c, i) => codes.indexOf(c) !== i);
  if (dup !== undefined) throw new LinenError("duplicate_item", { itemCode: dup });
  const known = new Set((await exec.select({ code: linenItems.code }).from(linenItems)
    .where(and(inArray(linenItems.code, codes), eq(linenItems.active, true)))).map((r) => r.code));
  const unknown = codes.find((c) => !known.has(c));
  if (unknown !== undefined) throw new LinenError("unknown_item", { itemCode: unknown });
}

export type MovementInsert = typeof linenMovements.$inferInsert;
export function movement(
  kind: LinenMovementKind, line: Line, actor: Actor, now: Date, extra: Partial<MovementInsert> = {},
): MovementInsert {
  return {
    id: newId(), kind, itemCode: line.itemCode, qty: line.qty, actorType: actor.type, actorId: actor.id,
    source: sourceOf(actor), at: now, ...extra,
  };
}

/** The same tap again (same kind, ward and key): the act already happened — answer what it wrote, write nothing. */
async function seenKey(t: Tx, kind: LinenMovementKind, wardId: string, key: string | undefined): Promise<number | null> {
  if (key === undefined) return null;
  const n = (await t.select({ id: linenMovements.id }).from(linenMovements).where(and(
    eq(linenMovements.kind, kind), eq(linenMovements.wardResourceId, wardId), eq(linenMovements.idempotencyKey, key),
  ))).length;
  return n > 0 ? n : null;
}

/* ═══════════════════════════════ store → ward ═══════════════════════════════ */

/**
 * Top a ward up from the linen store to par. No lines: every item short of par gets exactly its shortfall. Lines: those
 * pieces, each refused when it would put the ward above par (`above_par`, details `{ itemCode, max }`).
 */
export async function topUpWard(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<LinenActResult> {
  const input = parse(topUpWardInput, raw);
  return tx(exec, async (t) => {
    const ward = await requireWard(t, input.wardId);
    if (input.lines !== undefined) await requireItems(t, input.lines);
    await lock(t, `ward:${ward.id}`);
    const now = await stamp(t, nowIn);
    const seen = await seenKey(t, "issue_to_ward", ward.id, input.idempotencyKey);
    if (seen !== null) return { movements: seen, wardId: ward.id };
    const lines = await upToPar(t, ward.id, input.lines, now);
    if (lines.length === 0) throw new LinenError("at_par", { wardId: ward.id });
    await issueToWardIn(t, actor, ward.id, lines, now, { idempotencyKey: input.idempotencyKey ?? null });
    return { movements: lines.length, wardId: ward.id };
  });
}

/**
 * What a top-up issues: without lines, each item's shortfall (empty = the ward is at par); with lines, those pieces,
 * each refused above its shortfall (`above_par`). Call under the ward's lock.
 */
export async function upToPar(t: Tx, wardId: string, given: readonly Line[] | undefined, now: Date): Promise<Line[]> {
  const state = (await wardStates(t, now, wardId))[0];
  if (given === undefined) return (state?.items ?? []).filter((i) => i.short > 0).map((i) => ({ itemCode: i.itemCode, qty: i.short }));
  const byItem = new Map((state?.items ?? []).map((i) => [i.itemCode, i]));
  for (const l of given) {
    const max = byItem.get(l.itemCode)?.short ?? 0;
    if (l.qty > max) throw new LinenError("above_par", { itemCode: l.itemCode, max });
  }
  return [...given];
}

/** Store → ward: the movements, then (LD-1, D3) the beds waiting for this linen are made, oldest first. */
export async function issueToWardIn(
  t: Tx, actor: Actor, wardId: string, lines: readonly Line[], now: Date, extra: Partial<MovementInsert> = {},
): Promise<void> {
  await t.insert(linenMovements).values(lines.map((l) => movement("issue_to_ward", l, actor, now, { wardResourceId: wardId, ...extra })));
  await releaseLinenWaits(t, actor, wardId, now);
}

/* ═══════════════════════════════ ward → soiled room ═══════════════════════════════ */

async function returnFromWard(
  exec: Exec, actor: Actor, raw: unknown, nowIn: Date | undefined, kind: "return_soiled" | "return_infected",
): Promise<LinenActResult> {
  const input = parse(recordSoiledInput, raw);
  return tx(exec, async (t) => {
    const ward = await requireWard(t, input.wardId);
    await requireItems(t, input.lines);
    await lock(t, `ward:${ward.id}`);
    const now = await stamp(t, nowIn);
    const seen = await seenKey(t, kind, ward.id, input.idempotencyKey);
    if (seen !== null) return { movements: seen, wardId: ward.id };
    await requireOnHand(t, ward.id, input.lines, now);
    await t.insert(linenMovements).values(input.lines.map((l) => movement(kind, l, actor, now, {
      wardResourceId: ward.id, idempotencyKey: input.idempotencyKey ?? null,
    })));
    return { movements: input.lines.length, wardId: ward.id };
  });
}

/** Soiled linen, in the ordinary bag, from a ward to the soiled room. */
export const recordSoiled = (exec: Exec, actor: Actor, raw: unknown, now?: Date): Promise<LinenActResult> =>
  returnFromWard(exec, actor, raw, now, "return_soiled");

/** Infected linen (blood, body fluids, isolation beds) in its own marked bag: counted apart from the ordinary soiled. */
export const recordInfected = (exec: Exec, actor: Actor, raw: unknown, now?: Date): Promise<LinenActResult> =>
  returnFromWard(exec, actor, raw, now, "return_infected");

/* ═══════════════════════════════ the laundry ═══════════════════════════════ */

/** `LN-YYYYMMDD-NNNN` (IST day) from the never-reset `linen_batch_serial`. */
export function formatBatchNo(now: Date, serial: number): string {
  return `LN-${istDayString(now).replace(/-/g, "")}-${String(serial).padStart(4, "0")}`;
}

/**
 * One batch to the laundry: ordinary OR infected, never both. Each item is refused when more pieces are sent than wait
 * in that pool of the soiled room (`exceeds_soiled`) — so an infected batch cannot be made up from ordinary linen, and
 * ordinary linen cannot hide in an infected batch.
 *
 * LD-1 (#978): a batch is of ONE stream (`mixed_stream`: baby linen never with adult, theatre sets apart), goes to the
 * hospital's plant or the vendor (`mode`), and may carry sealed bags by tag — each bag's declared pieces travel with it
 * unopened, a held bag is refused (`on_hold`, D4), and loose lines are checked against the loose pool only.
 */
export async function sendToLaundry(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<LinenActResult> {
  const input = parse(sendToLaundryInput, raw);
  const loose = input.lines ?? [];
  return tx(exec, async (t) => {
    if (loose.length > 0) await requireItems(t, loose);
    await lock(t, "soiled-room");
    const now = await stamp(t, nowIn);
    if (input.idempotencyKey !== undefined) {
      const seen = (await t.select().from(linenLaundryBatches).where(eq(linenLaundryBatches.idempotencyKey, input.idempotencyKey)))[0];
      if (seen !== undefined) return { movements: loose.length, batchId: seen.id, batchNo: seen.batchNo };
    }
    const bags = await bagsForBatch(t, input.bagTags ?? [], input.infected);
    const pool = (await soiledPool(t, { loose: true }))[input.infected ? "infected" : "general"];
    for (const l of loose) {
      const waiting = pool[l.itemCode] ?? 0;
      if (l.qty > waiting) throw new LinenError("exceeds_soiled", { itemCode: l.itemCode, waiting, infected: input.infected });
    }
    const outLines = [...loose.map((l) => ({ ...l, bagId: null as string | null })), ...bags.flatMap((b) => b.lines.map((l) => ({ ...l, bagId: b.id })))];
    const stream = await streamOf(t, outLines.map((l) => l.itemCode));
    const serial = Number((await t.execute<{ n: string }>(sql`select nextval('linen_batch_serial') as n`)).rows[0]!.n);
    const batch = (await t.insert(linenLaundryBatches).values({
      id: newId(), batchNo: formatBatchNo(now, serial), infected: input.infected, stream, mode: input.mode,
      vendorName: input.vendorName ?? null, state: "sent", sentAt: now, sentBy: actor.id,
      piecesSent: outLines.reduce((n, l) => n + l.qty, 0), idempotencyKey: input.idempotencyKey ?? null,
    }).returning())[0]!;
    await t.insert(linenMovements).values(outLines.map((l) => movement("laundry_out", l, actor, now, { batchId: batch.id, bagId: l.bagId })));
    if (bags.length > 0) {
      await t.update(linenBags).set({ state: "sent", batchId: batch.id }).where(inArray(linenBags.id, bags.map((b) => b.id)));
    }
    return { movements: outLines.length, batchId: batch.id, batchNo: batch.batchNo };
  });
}

/** The one stream of a set of items; two streams in one batch are refused (`mixed_stream`). */
export async function streamOf(t: Exec, itemCodes: readonly string[]): Promise<LinenStream> {
  const rows = await t.selectDistinct({ stream: linenItems.stream }).from(linenItems).where(inArray(linenItems.code, [...new Set(itemCodes)]));
  if (rows.length !== 1) throw new LinenError("mixed_stream", { streams: rows.map((r) => r.stream) });
  return rows[0]!.stream as LinenStream;
}

/**
 * The sealed bags a batch takes, by tag: each must be waiting in the soiled room (`bag_not_here`), of the batch's kind
 * (`bag_wrong_batch`), and not on hold (`on_hold`, checked first: held linen is refused wherever it is).
 */
async function bagsForBatch(t: Tx, tags: readonly string[], infected: boolean): Promise<{ id: string; lines: Line[] }[]> {
  if (tags.length === 0) return [];
  if (new Set(tags).size !== tags.length) throw new LinenError("duplicate_item", { tags });
  const rows = await t.select().from(linenBags).where(and(inArray(linenBags.tag, [...tags]), inArray(linenBags.state, ["sealed", "picked"])));
  for (const tag of tags) {
    const bag = rows.find((r) => r.tag === tag);
    if (bag === undefined) throw new LinenError("unknown_bag", { tag });
    await requireNotHeld(t, bag);
    if (bag.state !== "picked") throw new LinenError("bag_not_here", { tag });
    if (bag.infected !== infected) throw new LinenError("bag_wrong_batch", { tag });
  }
  return rows.map((r) => ({ id: r.id, lines: r.lines }));
}

/**
 * What came back for a batch. Each item of the batch that came back short writes a `linen_variances` row (sent,
 * received, short); an item left out of the lines came back as 0. Received once: a second receipt is refused.
 */
export async function receiveFromLaundry(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<LinenActResult> {
  const input = parse(receiveFromLaundryInput, raw);
  return tx(exec, async (t) => {
    const batch = (await t.select().from(linenLaundryBatches).where(eq(linenLaundryBatches.id, input.batchId)).for("update"))[0];
    if (batch === undefined) throw new LinenError("unknown_batch", { batchId: input.batchId });
    if (batch.state !== "sent") throw new LinenError("already_received", { batchId: batch.id });
    const now = await stamp(t, nowIn);
    const sentRows = await t.select({ itemCode: linenMovements.itemCode, qty: linenMovements.qty }).from(linenMovements)
      .where(and(eq(linenMovements.batchId, batch.id), eq(linenMovements.kind, "laundry_out")));
    const sent = new Map<string, number>();
    for (const r of sentRows) sent.set(r.itemCode, (sent.get(r.itemCode) ?? 0) + r.qty);
    const got = new Map<string, number>();
    for (const l of input.lines) {
      if (got.has(l.itemCode)) throw new LinenError("duplicate_item", { itemCode: l.itemCode });
      const s = sent.get(l.itemCode);
      if (s === undefined) throw new LinenError("not_in_batch", { itemCode: l.itemCode });
      if (l.qty > s) throw new LinenError("more_than_sent", { itemCode: l.itemCode, sent: s });
      got.set(l.itemCode, l.qty);
    }
    const back = [...sent.keys()].map((itemCode) => ({ itemCode, sent: sent.get(itemCode)!, received: got.get(itemCode) ?? 0 }));
    const ins = back.filter((b) => b.received > 0);
    if (ins.length > 0) {
      await t.insert(linenMovements).values(ins.map((b) => movement("laundry_in", { itemCode: b.itemCode, qty: b.received }, actor, now, { batchId: batch.id })));
    }
    const shorts = back.filter((b) => b.received < b.sent);
    if (shorts.length > 0) {
      await t.insert(linenVariances).values(shorts.map((b) => ({
        id: newId(), kind: "laundry_short", batchId: batch.id, itemCode: b.itemCode, sent: b.sent, received: b.received,
        short: b.sent - b.received, recordedAt: now, recordedBy: actor.id,
      })));
    }
    await t.update(linenLaundryBatches).set({
      state: shorts.length > 0 ? "short" : "received", receivedAt: now, receivedBy: actor.id,
      piecesReceived: back.reduce((n, b) => n + b.received, 0),
    }).where(eq(linenLaundryBatches.id, batch.id));
    return { movements: ins.length, batchId: batch.id, batchNo: batch.batchNo, varianceRecords: shorts.length };
  });
}

/* ═══════════════════════════════ shortage: borrow ═══════════════════════════════ */

/** A ward short of linen borrows from another ward: one transfer row per item (from → to), counted on both books. */
export async function borrowBetweenWards(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<LinenActResult> {
  const input = parse(borrowBetweenWardsInput, raw);
  if (input.fromWardId === input.toWardId) throw new LinenError("same_ward", { wardId: input.fromWardId });
  return tx(exec, async (t) => {
    const from = await requireWard(t, input.fromWardId);
    const to = await requireWard(t, input.toWardId);
    await requireItems(t, input.lines);
    // Both wards, in a fixed order, so two opposite borrows never deadlock.
    for (const w of [from.id, to.id].sort()) await lock(t, `ward:${w}`);
    const now = await stamp(t, nowIn);
    const seen = await seenKey(t, "transfer_between_wards", from.id, input.idempotencyKey);
    if (seen !== null) return { movements: seen, wardId: to.id };
    await requireOnHand(t, from.id, input.lines, now);
    await t.insert(linenMovements).values(input.lines.map((l) => movement("transfer_between_wards", l, actor, now, {
      wardResourceId: from.id, toWardResourceId: to.id, idempotencyKey: input.idempotencyKey ?? null,
    })));
    await releaseLinenWaits(t, actor, to.id, now);
    return { movements: input.lines.length, wardId: to.id };
  });
}

/* ═══════════════════════════════ condemn (four eyes) ═══════════════════════════════ */

export async function requestCondemn(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<CondemnRow> {
  const input = parse(requestCondemnInput, raw);
  return tx(exec, async (t) => {
    const wardId = input.wardId ?? null;
    if (wardId !== null) await requireWard(t, wardId);
    await requireItems(t, [{ itemCode: input.itemCode, qty: input.qty }]);
    const now = await stamp(t, nowIn);
    return (await t.insert(linenCondemnRequests).values({
      id: newId(), wardResourceId: wardId, itemCode: input.itemCode, qty: input.qty, reason: input.reason,
      state: "requested", requestedBy: actor.id, requestedAt: now,
    }).returning())[0]!;
  });
}

async function decide(exec: Exec, actor: Actor, raw: unknown, nowIn: Date | undefined, approve: boolean): Promise<CondemnRow> {
  const input = parse(decideCondemnInput, raw);
  return tx(exec, async (t) => {
    const req = (await t.select().from(linenCondemnRequests).where(eq(linenCondemnRequests.id, input.requestId)).for("update"))[0];
    if (req === undefined) throw new LinenError("unknown_request", { requestId: input.requestId });
    if (req.state !== "requested") throw new LinenError("request_closed", { requestId: req.id, state: req.state });
    if (req.requestedBy === actor.id) throw new LinenError("approver_is_requester", { requestId: req.id });
    // A write-off comes off the ward's book: under the ward lock, never more than the ward still holds.
    if (approve && req.wardResourceId !== null) await lock(t, `ward:${req.wardResourceId}`);
    const now = await stamp(t, nowIn);
    if (approve && req.wardResourceId !== null) {
      await requireOnHand(t, req.wardResourceId, [{ itemCode: req.itemCode, qty: req.qty }], now);
    }
    const row = (await t.update(linenCondemnRequests).set({
      state: approve ? "approved" : "rejected", decidedBy: actor.id, decidedAt: now, decisionNote: input.note ?? null,
    }).where(eq(linenCondemnRequests.id, req.id)).returning())[0]!;
    if (approve) {
      await t.insert(linenMovements).values(movement("condemn", { itemCode: req.itemCode, qty: req.qty }, actor, now, {
        wardResourceId: req.wardResourceId, condemnRequestId: req.id,
      }));
    }
    return row;
  });
}

/** Approve a condemn request: writes the `condemn` movement (off the ward's book). Never by the requester. */
export const approveCondemn = (exec: Exec, actor: Actor, raw: unknown, now?: Date): Promise<CondemnRow> =>
  decide(exec, actor, raw, now, true);

/** Reject a condemn request: nothing leaves the book. Never by the requester either (DECIDED: one rule for both). */
export const rejectCondemn = (exec: Exec, actor: Actor, raw: unknown, now?: Date): Promise<CondemnRow> =>
  decide(exec, actor, raw, now, false);

/* ═══════════════════════════════ counts and par ═══════════════════════════════ */

/** The ward's count of its shelves: the new anchor of its book balance, item by item. */
export async function recordWardCount(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<LinenActResult> {
  const input = parse(recordWardCountInput, raw);
  return tx(exec, async (t) => {
    const ward = await requireWard(t, input.wardId);
    await requireItems(t, input.lines);
    await lock(t, `ward:${ward.id}`);
    const now = await stamp(t, nowIn);
    if (input.idempotencyKey !== undefined) {
      const seen = await t.select({ itemCode: linenWardCounts.itemCode, onHand: linenWardCounts.onHand }).from(linenWardCounts).where(and(
        eq(linenWardCounts.wardResourceId, ward.id), eq(linenWardCounts.idempotencyKey, input.idempotencyKey),
      ));
      if (seen.length > 0) {
        // The same tap again is the same count; the same key with other numbers is refused (PR #752 review).
        const same = seen.length === input.lines.length
          && input.lines.every((l) => seen.some((r) => r.itemCode === l.itemCode && r.onHand === l.qty));
        if (!same) throw new LinenError("key_reused", { wardId: ward.id });
        return { movements: 0, wardId: ward.id };
      }
    }
    await t.insert(linenWardCounts).values(input.lines.map((l) => ({
      id: newId(), wardResourceId: ward.id, itemCode: l.itemCode, onHand: l.qty, countedAt: now, countedBy: actor.id,
      source: sourceOf(actor), idempotencyKey: input.idempotencyKey ?? null,
    })));
    return { movements: 0, wardId: ward.id };
  });
}

/** Set a ward's par for one item over the computed one; `par: null` returns it to the computed par. */
export async function setParLevel(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<{ wardId: string; itemCode: string; par: number | null }> {
  const input = parse(setParLevelInput, raw);
  return tx(exec, async (t) => {
    const ward = await requireWard(t, input.wardId);
    await requireItems(t, [{ itemCode: input.itemCode, qty: 1 }]);
    const now = await stamp(t, nowIn);
    if (input.par === null) {
      await t.delete(linenParLevels).where(and(eq(linenParLevels.wardResourceId, ward.id), eq(linenParLevels.itemCode, input.itemCode)));
    } else {
      await t.insert(linenParLevels).values({ wardResourceId: ward.id, itemCode: input.itemCode, par: input.par, setBy: actor.id, setAt: now })
        .onConflictDoUpdate({ target: [linenParLevels.wardResourceId, linenParLevels.itemCode], set: { par: input.par, setBy: actor.id, setAt: now } });
    }
    return { wardId: ward.id, itemCode: input.itemCode, par: input.par };
  });
}
