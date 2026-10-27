import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { newId, openRoundInput, sealBagInput, signDeliveryInput, signPickupInput, weighBagInput } from "@hmis/contracts";
import { verifyPin, verifyPinByUsername } from "../../kernel/auth/identity";
import { linenBags, linenMovements, linenRounds } from "../../kernel/db/schema";
import { LinenError } from "./errors";
import { requireNotHeld, wardOfBed } from "./holds";
import { issueToWardIn, lock, movement, parse, requireItems, requireOnHand, requireWard, stamp, tx, upToPar } from "./intents";
import { pieceLines } from "./pieces";
import { soiledPool } from "./reads";
import type { Actor, LinenBagCard, LinenRoundCard, LinenRoundKind, LinenSealedBag, LinenSoiledRoomView } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { Exec, Line } from "./intents";

/**
 * ═══ THE FLOOR (LD-1, #978, D1) ═══ — rounds and sealed bags.
 *
 * A pickup is one signed act: loose linen by piece, sealed bags by tag, the runner (the caller) and EITHER the ward's
 * signature (a nurse's PIN, never the runner's own) OR "runner only" with a reason. Nothing is written until it is
 * signed, so a pickup without its signatures does not exist. A sealed bag's pieces were declared by the ward when it
 * sealed it; the runner and the soiled room never count it by piece — the ledger still moves the declared pieces.
 */
export type RoundRow = typeof linenRounds.$inferSelect;
export type BagRow = typeof linenBags.$inferSelect;

export function roundCard(r: RoundRow): LinenRoundCard {
  return {
    id: r.id, wardId: r.wardResourceId, kind: r.kind as LinenRoundKind, state: r.state as LinenRoundCard["state"],
    slotAt: r.slotAt?.toISOString() ?? null, runnerId: r.runnerId, runnerOnly: r.runnerOnlyReason !== null,
    wardSignedBy: r.wardSignedBy, pieces: r.pieces, bags: r.bags, signedAt: r.signedAt?.toISOString() ?? null,
  };
}

/** An on-call round at a ward (the clock raises the scheduled ones). */
export async function openRound(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<LinenRoundCard> {
  const input = parse(openRoundInput, raw);
  return tx(exec, async (t) => {
    const ward = await requireWard(t, input.wardId);
    const now = await stamp(t, nowIn);
    const row = (await t.insert(linenRounds).values({
      id: newId(), wardResourceId: ward.id, kind: input.kind, state: "open", createdBy: actor.id, createdAt: now,
    }).returning())[0]!;
    return roundCard(row);
  });
}

/** The ward seals a bag (at the bed, when `bedId` is given) and declares what is in it. Its pieces stay on the ward's book. */
export async function sealBag(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<{ id: string; tag: string }> {
  const input = parse(sealBagInput, raw);
  return tx(exec, async (t) => {
    const ward = await requireWard(t, input.wardId);
    await requireItems(t, input.lines);
    if (input.bedId !== undefined && (await wardOfBed(t, input.bedId))?.wardId !== ward.id) {
      throw new LinenError("unknown_bed", { bedId: input.bedId, wardId: ward.id });
    }
    await lock(t, `ward:${ward.id}`);
    const now = await stamp(t, nowIn);
    const live = await t.select({ id: linenBags.id }).from(linenBags)
      .where(and(eq(linenBags.tag, input.tag), inArray(linenBags.state, ["sealed", "picked"])));
    if (live.length > 0) throw new LinenError("tag_in_use", { tag: input.tag });
    await requireOnHand(t, ward.id, input.lines, now);
    const row = (await t.insert(linenBags).values({
      id: newId(), tag: input.tag, wardResourceId: ward.id, bedResourceId: input.bedId ?? null, infected: input.infected,
      lines: input.lines, state: "sealed", sealedBy: actor.id, sealedAt: now,
    }).returning())[0]!;
    return { id: row.id, tag: row.tag };
  });
}

/** The ward's sealed bag with this tag, on this ward: refused when unknown, already gone, or held. */
async function bagForPickup(t: Tx, tag: string, wardId: string): Promise<BagRow> {
  const bag = (await t.select().from(linenBags).where(eq(linenBags.tag, tag)).orderBy(desc(linenBags.sealedAt)).limit(1).for("update"))[0];
  if (bag === undefined || bag.wardResourceId !== wardId) throw new LinenError("unknown_bag", { tag });
  if (bag.state !== "sealed") throw new LinenError("bag_gone", { tag, state: bag.state });
  await requireNotHeld(t, bag);
  return bag;
}

/** Add `lines` into `into` per item (the pieces one act takes off a ward's book). */
function addLines(into: Map<string, number>, lines: readonly Line[]): void {
  for (const l of lines) into.set(l.itemCode, (into.get(l.itemCode) ?? 0) + l.qty);
}

/**
 * Sign a pickup (D1). Refused without a ward signature or a runner-only reason (`ward_signature_missing`), with both
 * (`bad_input`), with a wrong PIN (`bad_pin`), or when the runner signs for the ward (`signer_is_runner`).
 */
export async function signPickup(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<LinenRoundCard> {
  const input = parse(signPickupInput, raw);
  const loose = input.lines ?? [];
  const tags = (input.bags ?? []).map((b) => b.tag);
  const pieceTags = input.pieceTags ?? [];
  if (loose.length === 0 && tags.length === 0 && pieceTags.length === 0) throw new LinenError("bad_input", { issues: ["lines, bags or pieceTags"] });
  if (new Set(tags).size !== tags.length) throw new LinenError("duplicate_item", { tags });
  const wardSigner = await requireSignature(exec, actor, input);
  return tx(exec, async (t) => {
    const round = await openRoundFor(t, input.roundId, "pickup");
    const wardId = round.wardResourceId;
    if (loose.length > 0) await requireItems(t, loose);
    // LD-2 (D6): each scanned piece moves as itself; a hand count moves the same totals.
    const tagged = await pieceLines(t, pieceTags);
    await lock(t, `ward:${wardId}`);
    const now = await stamp(t, nowIn);
    const bags: BagRow[] = [];
    for (const tag of tags) bags.push(await bagForPickup(t, tag, wardId));
    const taken = new Map<string, number>();
    addLines(taken, loose);
    addLines(taken, tagged);
    for (const b of bags) addLines(taken, b.lines);
    await requireOnHand(t, wardId, [...taken].map(([itemCode, qty]) => ({ itemCode, qty })), now);
    const rows = [
      ...loose.map((l) => movement("return_soiled", l, actor, now, { wardResourceId: wardId, roundId: round.id })),
      ...tagged.map((l) => movement("return_soiled", { itemCode: l.itemCode, qty: 1 }, actor, now, { wardResourceId: wardId, roundId: round.id, pieceId: l.pieceId })),
      ...bags.flatMap((b) => b.lines.map((l) => movement(b.infected ? "return_infected" : "return_soiled", l, actor, now, {
        wardResourceId: wardId, roundId: round.id, bagId: b.id,
      }))),
    ];
    await t.insert(linenMovements).values(rows);
    if (bags.length > 0) await t.update(linenBags).set({ state: "picked", roundId: round.id }).where(inArray(linenBags.id, bags.map((b) => b.id)));
    const signed = (await t.update(linenRounds).set({
      state: "signed", runnerId: actor.id, wardSignedBy: wardSigner,
      runnerOnlyReason: input.runnerOnlyReason ?? null, pieces: loose.reduce((n, l) => n + l.qty, 0) + tagged.length, bags: bags.length, signedAt: now,
    }).where(eq(linenRounds.id, round.id)).returning())[0]!;
    return roundCard(signed);
  });
}

export type Signature = { userId: string; pin: string } | { username: string; pin: string };

/** The signer of an on-the-spot signature, by PIN (`bad_pin` for a wrong PIN or an unknown name). → their user id. */
export async function signerOf(exec: Exec, sig: Signature): Promise<string> {
  if ("userId" in sig) {
    if (!(await verifyPin(exec as Db, sig.userId, sig.pin))) throw new LinenError("bad_pin");
    return sig.userId;
  }
  const hit = await verifyPinByUsername(exec as Db, sig.username, sig.pin);
  if (hit === null) throw new LinenError("bad_pin");
  return hit.userId;
}

/** The ward's signature (a PIN, never the runner's) XOR runner-only with a reason. → the ward signer, or null. */
async function requireSignature(exec: Exec, actor: Actor, input: { wardSign?: Signature; runnerOnlyReason?: string }): Promise<string | null> {
  if (input.wardSign !== undefined && input.runnerOnlyReason !== undefined) throw new LinenError("bad_input", { issues: ["wardSign or runnerOnlyReason, not both"] });
  if (input.wardSign === undefined && input.runnerOnlyReason === undefined) throw new LinenError("ward_signature_missing");
  if (input.wardSign === undefined) return null;
  if ("userId" in input.wardSign && input.wardSign.userId === actor.id) throw new LinenError("signer_is_runner");
  const signer = await signerOf(exec, input.wardSign);
  if (signer === actor.id) throw new LinenError("signer_is_runner");
  return signer;
}

async function openRoundFor(t: Tx, roundId: string, kind: LinenRoundKind): Promise<RoundRow> {
  const round = (await t.select().from(linenRounds).where(eq(linenRounds.id, roundId)).for("update"))[0];
  if (round === undefined) throw new LinenError("unknown_round", { roundId });
  if (round.state !== "open") throw new LinenError("round_closed", { roundId: round.id });
  if (round.kind !== kind) throw new LinenError(kind === "pickup" ? "not_a_pickup" : "not_a_delivery", { roundId: round.id });
  return round;
}

/**
 * Sign a delivery: the linen store's pieces reach the ward (no lines = up to par), signed like a pickup. A ward already
 * at par is recorded as skipped, with no signature to ask for. The delivery makes the beds waiting for linen (D3).
 */
export async function signDelivery(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<LinenRoundCard> {
  const input = parse(signDeliveryInput, raw);
  return tx(exec, async (t) => {
    const round = await openRoundFor(t, input.roundId, "delivery");
    const wardId = round.wardResourceId;
    if (input.lines !== undefined) await requireItems(t, input.lines);
    await lock(t, `ward:${wardId}`);
    const now = await stamp(t, nowIn);
    const lines = await upToPar(t, wardId, input.lines, now);
    if (lines.length === 0) {
      const skipped = (await t.update(linenRounds).set({ state: "skipped", runnerId: actor.id })
        .where(eq(linenRounds.id, round.id)).returning())[0]!;
      return roundCard(skipped);
    }
    const wardSigner = await requireSignature(t, actor, input);
    await issueToWardIn(t, actor, wardId, lines, now, { roundId: round.id });
    const signed = (await t.update(linenRounds).set({
      state: "signed", runnerId: actor.id, wardSignedBy: wardSigner,
      runnerOnlyReason: input.runnerOnlyReason ?? null, pieces: lines.reduce((n, l) => n + l.qty, 0), signedAt: now,
    }).where(eq(linenRounds.id, round.id)).returning())[0]!;
    return roundCard(signed);
  });
}

/** The soiled room weighs a sealed bag that came in on a round; it never opens it. */
export async function weighBag(exec: Exec, _actor: Actor, raw: unknown): Promise<LinenBagCard> {
  const input = parse(weighBagInput, raw);
  return tx(exec, async (t) => {
    const bag = (await t.select().from(linenBags).where(and(eq(linenBags.tag, input.tag), eq(linenBags.state, "picked"))).for("update"))[0];
    if (bag === undefined) throw new LinenError("bag_not_here", { tag: input.tag });
    await t.update(linenBags).set({ weightGrams: input.weightGrams }).where(eq(linenBags.id, bag.id));
    return { tag: bag.tag, wardId: bag.wardResourceId, weightGrams: input.weightGrams };
  });
}

/** The soiled room: ordinary linen by item, infected linen as sealed bags by tag and weight — no piece count (D1). */
export async function soiledRoomView(exec: Exec): Promise<LinenSoiledRoomView> {
  const pool = await soiledPool(exec);
  const bags = await exec.select({ tag: linenBags.tag, wardId: linenBags.wardResourceId, weightGrams: linenBags.weightGrams })
    .from(linenBags).where(and(eq(linenBags.state, "picked"), eq(linenBags.infected, true))).orderBy(asc(linenBags.sealedAt), asc(linenBags.tag));
  return { general: pool.general, infectedBags: bags };
}

/** Open and recently signed rounds, newest first. */
export async function recentRounds(exec: Exec, limit = 30): Promise<LinenRoundCard[]> {
  const rows = await exec.select().from(linenRounds).orderBy(desc(linenRounds.createdAt)).limit(limit);
  return rows.map(roundCard);
}

/** Bags sealed on the wards and not yet picked up, oldest first; a bag whose bed is under an active hold says so. */
export async function sealedBags(exec: Exec): Promise<LinenSealedBag[]> {
  const r = await exec.execute<{ tag: string; ward: string; bed: string | null; bed_name: string | null; infected: boolean; held: boolean }>(sql`
    select b.tag, b.ward_resource_id as ward, b.bed_resource_id as bed, r.name as bed_name, b.infected,
           exists (select 1 from linen_holds h where h.bed_resource_id = b.bed_resource_id and h.state = 'active') as held
      from linen_bags b left join resources r on r.id = b.bed_resource_id
     where b.state = 'sealed' order by b.sealed_at, b.tag`);
  return r.rows.map((x) => ({ tag: x.tag, wardId: x.ward, bedId: x.bed, bedName: x.bed_name, infected: x.infected, held: x.held }));
}

/** Every non-retired bed under a ward (bed → room → ward), by name. */
export async function wardBeds(exec: Exec): Promise<{ bedId: string; bedName: string; wardId: string }[]> {
  const r = await exec.execute<{ bed: string; name: string; ward: string }>(sql`
    with recursive up as (
      select id as bed, name, parent_id as at, 1 as depth from resources where kind = 'bed' and status <> 'retired'
      union all
      select u.bed, u.name, p.parent_id, u.depth + 1 from up u join resources p on p.id = u.at where p.kind <> 'ward' and u.depth < 8
    ) select u.bed, u.name, w.id as ward from up u join resources w on w.id = u.at and w.kind = 'ward' order by w.id, u.name`);
  return r.rows.map((x) => ({ bedId: x.bed, bedName: x.name, wardId: x.ward }));
}
