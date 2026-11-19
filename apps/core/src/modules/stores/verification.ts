import { and, desc, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { storesAssetUnitEvents, storesAssetVerifications } from "../../kernel/db/schema";
import { STORES_SHELF_READ, STORES_SHELF_WORK, departmentOf, holds, recordAct, requireShelf } from "./access";
import { STORES_ASSETS_MANAGE, appendUnitEvents, assetPassport, itemName, lastTag, storeInfos, unitStates } from "./assets";
import { StoresError } from "./errors";
import type { Actor, WireVerificationRound } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S4a (#1114, decision 12, flow step 7) — THE VERIFICATION ROUND. The department's in-charge and a storekeeper
 * walk with the phone and scan: `startVerification` → each scan a `verified_seen` unit event naming the round and the
 * shelf it was scanned at → `closeVerification`, which lists "Not seen" (a unit at one of the department's shelves
 * that no scan of the round saw) and "Wrong place" (a unit scanned at a shelf other than its derived place). Nothing is
 * moved or written off by a round: the books stay, and a unit still not seen 30 days later is S4b's loss proposal.
 * Medical equipment every 6 months, everything else yearly (DECIDED, NABH FMS practice).
 */
type RoundRow = typeof storesAssetVerifications.$inferSelect;

async function mayVerify(db: Db | Tx, actor: Actor, departmentId: string): Promise<void> {
  if ((await holds(db, actor, STORES_SHELF_WORK, departmentId)) || (await holds(db, actor, STORES_ASSETS_MANAGE))) return;
  throw new StoresError("not_permitted", "the department's in-charge or the store walks the round", { permission: STORES_SHELF_WORK });
}

async function rounds(db: Db | Tx, roundId: string): Promise<{ start: RoundRow; close: RoundRow | null }> {
  const rows = await (db as Db).select().from(storesAssetVerifications).where(eq(storesAssetVerifications.roundId, roundId));
  const start = rows.find((r) => r.kind === "start");
  if (start === undefined) throw new StoresError("unknown_round", "no such round", { roundId });
  return { start, close: rows.find((r) => r.kind === "close") ?? null };
}

/** The units a department is expected to show: live, at one of its shelves. */
async function expectedUnits(db: Db | Tx, departmentId: string) {
  return [...(await unitStates(db)).values()].filter((s) => s.ended === null && s.place.kind === "shelf" && s.place.departmentId === departmentId);
}

export async function startVerification(db: Db, actor: Actor, input: { departmentId: string }, now: Date = new Date()): Promise<{ roundId: string }> {
  await departmentOf(db, input.departmentId);
  await mayVerify(db, actor, input.departmentId);
  return withTx(db, async (tx) => {
    const open = await openRoundOf(tx, input.departmentId);
    if (open !== null) return { roundId: open };
    const id = newId();
    await tx.insert(storesAssetVerifications).values({ id, roundId: id, kind: "start", departmentId: input.departmentId, actorId: actor.id, at: now, result: null });
    await recordAct(tx, actor, now, { act: "start_round", refId: id, after: { departmentId: input.departmentId } });
    return { roundId: id };
  });
}

async function openRoundOf(db: Db | Tx, departmentId: string): Promise<string | null> {
  const rows = await (db as Db).select().from(storesAssetVerifications)
    .where(eq(storesAssetVerifications.departmentId, departmentId)).orderBy(desc(storesAssetVerifications.at));
  const closed = new Set(rows.filter((r) => r.kind === "close").map((r) => r.roundId));
  return rows.find((r) => r.kind === "start" && !closed.has(r.roundId))?.roundId ?? null;
}

/** One scan of the round: the unit by its id or its scanned / typed code, at the shelf the walker stands at. */
export async function scanVerification(
  db: Db, actor: Actor, roundId: string, input: { unitId?: string; code?: string; shelfId: string }, now: Date = new Date(),
): Promise<WireVerificationRound> {
  const { start, close } = await rounds(db, roundId);
  if (close !== null) throw new StoresError("round_closed", "Round closed");
  await mayVerify(db, actor, start.departmentId);
  const shelf = await requireShelf(db, input.shelfId);
  let unitId = input.unitId;
  if (unitId === undefined) {
    const p = await assetPassport(db, actor, { code: input.code ?? "" }, now);
    if (p.access === "choose") throw new StoresError("ambiguous_code", "two units match: scan the label");
    unitId = p.unit.id;
  }
  await withTx(db, async (tx) => {
    const seen = await tx.select({ id: storesAssetUnitEvents.id }).from(storesAssetUnitEvents)
      .where(and(eq(storesAssetUnitEvents.unitId, unitId!), eq(storesAssetUnitEvents.kind, "verified_seen"), eq(storesAssetUnitEvents.refId, roundId))).limit(1);
    if (seen.length > 0) return; // a second scan of the same unit in the round ticks nothing new
    await appendUnitEvents(tx, actor, now, [{ unitId: unitId!, kind: "verified_seen", refType: "verification", refId: roundId, data: { shelfId: shelf.id } }]);
  });
  return roundView(db, roundId);
}

/** Decision 12: close the round. Lists Not seen and Wrong place, keeps them on the close row, moves nothing. */
export async function closeVerification(db: Db, actor: Actor, roundId: string, now: Date = new Date()): Promise<WireVerificationRound> {
  const { start, close } = await rounds(db, roundId);
  if (close !== null) throw new StoresError("round_closed", "Round closed");
  await mayVerify(db, actor, start.departmentId);
  const view = await roundView(db, roundId);
  await withTx(db, async (tx) => {
    await tx.insert(storesAssetVerifications).values({
      id: newId(), roundId, kind: "close", departmentId: start.departmentId, actorId: actor.id, at: now,
      result: { notSeen: view.notSeen, wrongPlace: view.wrongPlace, seen: view.seen, expected: view.expected },
    });
    await recordAct(tx, actor, now, { act: "close_round", refId: roundId, after: { notSeen: view.notSeen.length, wrongPlace: view.wrongPlace.length } });
  });
  return { ...view, closedAt: now.toISOString() };
}

export async function roundView(db: Db | Tx, roundId: string): Promise<WireVerificationRound> {
  const { start, close } = await rounds(db, roundId);
  if (close?.result != null) {
    const r = close.result as Pick<WireVerificationRound, "notSeen" | "wrongPlace" | "seen" | "expected">;
    const d = await departmentOf(db, start.departmentId);
    return { roundId, department: { id: d.id, name: d.name }, startedAt: start.at.toISOString(), closedAt: close.at.toISOString(), ...r };
  }
  const scans = await (db as Db).select().from(storesAssetUnitEvents)
    .where(and(eq(storesAssetUnitEvents.kind, "verified_seen"), eq(storesAssetUnitEvents.refId, roundId)));
  const expected = await expectedUnits(db, start.departmentId);
  const scannedIds = new Set(scans.map((s) => s.unitId));
  const scannedStates = await unitStates(db, [...scannedIds]);
  const shelves = await storeInfos(db, scans.map((s) => String((s.data as { shelfId: string }).shelfId)));
  const notSeen = [];
  for (const s of expected.filter((u) => !scannedIds.has(u.unit.id))) {
    notSeen.push({ unitId: s.unit.id, tagNo: lastTag(s), name: await itemName(db, s.unit.itemId), place: s.place.name });
  }
  const wrongPlace = [];
  for (const sc of scans) {
    const s = scannedStates.get(sc.unitId);
    const at = String((sc.data as { shelfId: string }).shelfId);
    if (s !== undefined && s.place.id !== at) {
      wrongPlace.push({ unitId: s.unit.id, tagNo: lastTag(s), name: await itemName(db, s.unit.itemId), place: s.place.name, seenAt: shelves.get(at)?.name ?? "" });
    }
  }
  const d = await departmentOf(db, start.departmentId);
  return {
    roundId, department: { id: d.id, name: d.name }, startedAt: start.at.toISOString(), closedAt: null,
    seen: expected.filter((u) => scannedIds.has(u.unit.id)).length, expected: expected.length,
    notSeen: notSeen.sort((a, b) => a.tagNo.localeCompare(b.tagNo)), wrongPlace: wrongPlace.sort((a, b) => a.tagNo.localeCompare(b.tagNo)),
  };
}

/** The rounds this person may see (their departments', or every one for biomedical), newest first, and the departments they may start one for. */
export async function verificationRounds(db: Db, actor: Actor): Promise<{ rounds: WireVerificationRound[]; departments: { id: string; name: string }[] }> {
  const all = await db.select().from(storesAssetVerifications).where(eq(storesAssetVerifications.kind, "start")).orderBy(desc(storesAssetVerifications.at)).limit(100);
  const manage = await holds(db, actor, STORES_ASSETS_MANAGE);
  const out: WireVerificationRound[] = [];
  for (const r of all) {
    if (manage || (await holds(db, actor, STORES_SHELF_READ, r.departmentId))) out.push(await roundView(db, r.roundId));
  }
  // Departments that have a Stores shelf.
  const depts = (await db.execute<{ id: string; name: string }>(
    sql`select distinct d.id, d.name from org_departments d join resources r on r.attributes->>'departmentId' = d.id
      where r.kind = 'store' and r.attributes->>'domain' = 'stores' and r.attributes->>'kind' = 'shelf' order by d.name`)).rows;
  const mine = [];
  for (const d of depts) if (manage || (await holds(db, actor, STORES_SHELF_WORK, d.id))) mine.push(d);
  return { rounds: out, departments: mine };
}
